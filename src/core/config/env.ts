import dotenv from 'dotenv';
import path from 'node:path';

// `quiet`: sem ele o dotenv imprime uma linha de texto puro na subida, e a
// primeira linha do log deixa de ser JSON. No contêiner não há .env (o
// .dockerignore o exclui) e as variáveis vêm do ambiente.
dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

/** Prefixo de todas as rotas do serviço; o Ingress compartilhado encaminha por ele. */
export const PREFIXO_ROTAS = 'billing';

function must(name: string): void {
  if (!process.env[name]) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
}

export function validateEnv(): void {
  must('NODE_ENV');
  must('APPLICATION_PORT');
  must('JWT_SECRET');
  must('WEBHOOK_ORCAMENTO_TOKEN');

  // Banco próprio (terraform/rds.tf) e mensageria (terraform/sqs.tf): a fila
  // consumida e a fila de respostas da Saga.
  must('DATABASE_URL');
  must('AWS_REGION');
  must('BILLING_COMMANDS_QUEUE_URL');
  must('SAGA_REPLIES_QUEUE_URL');

  // Mercado Pago (QR Code): o token e o caixa a que as cobranças ficam ligadas.
  // MERCADO_PAGO_API_URL (padrão: a API real) só muda nos testes, que usam um
  // simulador. O e-mail (MAIL_LAMBDA_URL e MAIL_LAMBDA_TOKEN) é opcional: sem
  // ele, o serviço funciona, mas nenhum e-mail sai. O endereço do aviso de
  // pagamento não é variável: fica no painel do Mercado Pago (README).
  must('MERCADO_PAGO_ACCESS_TOKEN');
  must('MERCADO_PAGO_CAIXA_ID');
}
