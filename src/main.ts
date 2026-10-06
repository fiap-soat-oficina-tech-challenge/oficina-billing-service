import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters';
import {
  configurarTelemetria,
  notificarErro,
  registrarEvento,
  tagsDeObservabilidade,
} from './common/observability';
import { PREFIXO_ROTAS, validateEnv } from './core/config/env';

async function bootstrap() {
  validateEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  configurarTelemetria(await app.resolve(PinoLogger));

  // Todas as rotas ficam sob o prefixo do serviço: é por ele que o Ingress
  // compartilhado (um ALB para os três serviços) encaminha a requisição.
  app.setGlobalPrefix(PREFIXO_ROTAS);

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Oficina — Billing Service')
    .setDescription('Orçamentos, aprovação e pagamentos com o Mercado Pago.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup(`${PREFIXO_ROTAS}/api`, app, () =>
    SwaggerModule.createDocument(app, config),
  );

  const porta = process.env.APPLICATION_PORT ?? 3000;
  await app.listen(porta);

  registrarEvento('aplicacao.iniciada', {
    porta: Number(porta),
    node_env: process.env.NODE_ENV,
  });
}

bootstrap().catch((error: unknown) => {
  // Sem pino ainda: a linha é montada à mão, no mesmo contrato de campos dos
  // demais logs, para continuar sendo JSON e cair nos mesmos filtros.
  const erro = error instanceof Error ? error : new Error(String(error));

  notificarErro(erro, { evento: 'aplicacao.falha_ao_iniciar' });

  process.stderr.write(
    JSON.stringify({
      level: 'fatal',
      timestamp: Date.now(),
      servico: process.env.NEW_RELIC_APP_NAME ?? 'oficina-billing',
      environment: process.env.NODE_ENV ?? 'desconhecido',
      ...tagsDeObservabilidade(),
      evento: 'aplicacao.falha_ao_iniciar',
      'error.class': erro.name,
      'error.message': erro.message,
      'error.stack': erro.stack,
      message: `Falha ao iniciar a aplicação: ${erro.message}`,
    }) + '\n',
  );

  process.exit(1);
});
