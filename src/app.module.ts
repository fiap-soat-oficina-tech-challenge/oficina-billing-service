import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  metadadosDeTrace,
  tagsDeObservabilidade,
} from './common/observability';
import { TelemetriaShutdown } from './common/observability/telemetria-shutdown';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Mesmo contrato de logs do OS Service (campos lidos pelo New Relic e
    // correlationId por requisição), para os três serviços caírem nas mesmas
    // consultas. O correlationId recebido no header x-correlation-id é mantido,
    // e é por ele que se acompanha uma OS de ponta a ponta.
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',

        // ─── Contrato de campos esperado pelo New Relic ────────────────────
        // Três renomeações que parecem cosméticas e não são: com os nomes
        // padrão do pino, o log chega mas é indexado errado.

        // `msg` viraria um atributo qualquer e a UI mostraria o JSON cru na
        // lista de logs; `message` é o campo que o New Relic trata como corpo.
        messageKey: 'message',

        // `level` numérico (30, 50) não é mapeado para severidade. O rótulo é.
        formatters: {
          level: (label: string) => ({ level: label }),
        },

        // `time` não é reconhecido: o registro assumiria o horário de ingestão,
        // e um atraso no Fluent Bit reordenaria a linha do tempo justamente
        // durante um incidente. `timestamp` em epoch ms é lido corretamente.
        // A opção recebe o fragmento serializado, daí a vírgula inicial.
        timestamp: () => `,"timestamp":${Date.now()}`,

        // Substituem o par pid/hostname padrão. `environment` e `project` são
        // as tags do projeto em toda a telemetria, e é por elas (mais `servico`)
        // que os alertas e os painéis filtram — escritas pela aplicação, não
        // dependem da convenção de nomes do coletor.
        //
        // Vêm de NEW_RELIC_LABELS, a mesma variável com que o agente de APM
        // marca a entidade: um valor governa as tags do APM e as do log.
        base: {
          servico: process.env.NEW_RELIC_APP_NAME ?? 'oficina-billing',
          environment: process.env.NODE_ENV ?? 'desconhecido',
          ...tagsDeObservabilidade(),
        },

        // Roda a cada linha e acrescenta `trace.id`, `span.id`, `entity.guid` e
        // `entity.name` do APM. É o que liga log e trace distribuído nos dois
        // sentidos. Com o agente desligado devolve objeto vazio, e o log sai
        // igual, sem os campos de correlação.
        mixin: () => metadadosDeTrace(),

        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const header =
            req.headers['x-correlation-id'] ??
            req.headers['x-request-id'] ??
            req.headers['x-amzn-request-id'] ??
            req.headers['x-amzn-trace-id'];
          const id =
            (Array.isArray(header) ? header[0] : header) ?? randomUUID();
          res.setHeader('x-correlation-id', id);
          return id;
        },

        // ─── Volume (free tier: 100 GB/mês) ────────────────────────────────
        // Por padrão o pino-http prende o `req` inteiro — headers, query,
        // params, IP e porta — a TODA linha emitida dentro da requisição, não
        // só à de "request completed". São 0,6–1 KB repetidos por linha.
        //
        // Com `quietReqLogger`, as linhas de dentro da requisição levam só o id,
        // gravado como `correlationId` (o mesmo nome de antes, então nenhuma
        // consulta muda). O `req` completo fica apenas na linha de conclusão,
        // e mesmo ali reduzido pelos serializers abaixo.
        quietReqLogger: true,
        customAttributeKeys: { reqId: 'correlationId' },

        // Método e rota bastam para responder "o que foi chamado"; o APM já tem
        // o resto por transação. A query string sai de propósito: log não leva
        // dado pessoal, e filtros de consulta podem carregar algum.
        serializers: {
          req: (req: { method?: string; url?: string }) => ({
            method: req.method,
            url: (req.url ?? '').split('?')[0],
          }),
          res: (res: { statusCode?: number }) => ({
            statusCode: res.statusCode,
          }),
        },
        // Não polui o log com o ruído das sondas de saúde e do Swagger.
        autoLogging: {
          ignore: (req: IncomingMessage) => {
            const url = req.url ?? '';
            return (
              url.startsWith('/billing/health') ||
              url.startsWith('/billing/api')
            );
          },
        },
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-webhook-token"]',
          'req.headers["x-internal-token"]',
        ],
      },
    }),
    AuthModule,
    HealthModule,
  ],
  providers: [TelemetriaShutdown],
})
export class AppModule {}
