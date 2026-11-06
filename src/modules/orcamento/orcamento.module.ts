import { Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { PublicadorSqs } from '../../common/mensageria/publicador-sqs';
import { PrismaService } from '../prisma/prisma.service';
import { GATEWAY_PAGAMENTO } from './application/ports/gateway-pagamento';
import { NOTIFICADOR } from './application/ports/notificador';
import { PUBLICADOR_RESPOSTAS } from './application/ports/publicador-respostas';
import { EstornoDePagamento } from './application/shared/estorno-de-pagamento';
import { CancelarOrcamentoUseCase } from './application/use-case/cancelar-orcamento.use-case';
import { ConsultarOrcamentosUseCase } from './application/use-case/consultar-orcamentos.use-case';
import { DecidirOrcamentoUseCase } from './application/use-case/decidir-orcamento.use-case';
import { EstornarPagamentoUseCase } from './application/use-case/estornar-pagamento.use-case';
import { GerarOrcamentoUseCase } from './application/use-case/gerar-orcamento.use-case';
import { ProcessarNotificacaoPagamentoUseCase } from './application/use-case/processar-notificacao-pagamento.use-case';
import { ORCAMENTO_REPOSITORY } from './domain/repository/orcamento.repository';
import { PAGAMENTO_REPOSITORY } from './domain/repository/pagamento.repository';
import { TRANSACAO } from './domain/repository/transacao';
import { MercadoPagoGateway } from './infra/mercado-pago/mercado-pago.gateway';
import { LambdaEmailNotificador } from './infra/notificacao/lambda-email.notificador';
import { PrismaOrcamentoRepository } from './infra/prisma/prisma-orcamento.repository';
import { PrismaPagamentoRepository } from './infra/prisma/prisma-pagamento.repository';
import { PrismaTransacao } from './infra/prisma/prisma-transacao';
import { ComandosConsumer } from './interface/consumer/comandos.consumer';
import { OrcamentoController } from './interface/controller/orcamento.controller';
import { PagamentoController } from './interface/controller/pagamento.controller';
import { WebhookController } from './interface/controller/webhook.controller';

/**
 * Orçamentos e pagamentos. As portas da camada de aplicação (repositórios,
 * transação, publicador, gateway de pagamento e notificador) são ligadas aqui
 * às implementações de infraestrutura, com a configuração vinda do ambiente
 * (validada em core/config/env.ts).
 */
@Module({
  controllers: [OrcamentoController, PagamentoController, WebhookController],
  providers: [
    {
      provide: ORCAMENTO_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaOrcamentoRepository(prisma),
    },
    {
      provide: PAGAMENTO_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new PrismaPagamentoRepository(prisma),
    },
    {
      provide: TRANSACAO,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaTransacao(prisma),
    },
    {
      provide: PUBLICADOR_RESPOSTAS,
      inject: [SQSClient],
      useFactory: (sqs: SQSClient) =>
        new PublicadorSqs(sqs, process.env.SAGA_REPLIES_QUEUE_URL ?? ''),
    },
    {
      provide: GATEWAY_PAGAMENTO,
      useFactory: () =>
        new MercadoPagoGateway({
          apiUrl:
            process.env.MERCADO_PAGO_API_URL ?? 'https://api.mercadopago.com',
          accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN ?? '',
          caixaId: process.env.MERCADO_PAGO_CAIXA_ID ?? '',
        }),
    },
    {
      provide: NOTIFICADOR,
      useFactory: () =>
        new LambdaEmailNotificador({
          url: process.env.MAIL_LAMBDA_URL,
          token: process.env.MAIL_LAMBDA_TOKEN,
        }),
    },
    EstornoDePagamento,
    GerarOrcamentoUseCase,
    DecidirOrcamentoUseCase,
    ProcessarNotificacaoPagamentoUseCase,
    CancelarOrcamentoUseCase,
    EstornarPagamentoUseCase,
    ConsultarOrcamentosUseCase,
    ComandosConsumer,
  ],
})
export class OrcamentoModule {}
