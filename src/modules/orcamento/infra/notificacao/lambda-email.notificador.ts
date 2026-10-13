import {
  registrarEvento,
  registrarFalha,
} from '../../../../common/observability';
import type { Notificador } from '../../application/ports/notificador';
import type { LinhaOrcamento, Orcamento } from '../../domain/orcamento';

export interface ConfiguracaoEmail {
  /** Rota `/mail` da Lambda de notificações (API Gateway). */
  url?: string;
  /** Header `x-mail-api-token` exigido pela Lambda. */
  token?: string;
}

const TIMEOUT_MS = 15_000;

const moeda = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const dataHora = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});

/**
 * E-mails do Billing pela Lambda de notificações, como o OS Service faz desde a
 * Fase 3: um POST autenticado para `/mail`, e a Lambda cuida do SMTP.
 *
 * Best-effort: falha no envio fica no log e nunca desfaz a operação. Sem e-mail
 * no cadastro do cliente, ou sem a Lambda configurada (ambiente local), nada é
 * enviado.
 */
export class LambdaEmailNotificador implements Notificador {
  constructor(private readonly config: ConfiguracaoEmail) {}

  enviarOrcamento(orcamento: Orcamento): Promise<void> {
    const texto = [
      `Olá ${orcamento.cliente.nome},`,
      '',
      `Segue o orçamento da Ordem de Serviço ${orcamento.codigoOS}:`,
      '',
      ...secao('Serviços', orcamento.servicos),
      ...secao('Peças e insumos', orcamento.itens),
      `Valor dos serviços: ${moeda.format(orcamento.valorServicos)}`,
      `Valor das peças: ${moeda.format(orcamento.valorPecas)}`,
      `Total: ${moeda.format(orcamento.valorTotal)}`,
      '',
      'Para aprovar ou recusar, autentique-se com o seu CPF para obter o token',
      'de acesso e use as rotas abaixo, com o token no header Authorization:',
      `  Aprovar: POST /billing/orcamentos/${orcamento.id}/aprovar`,
      `  Recusar: POST /billing/orcamentos/${orcamento.id}/recusar`,
      '',
      'Depois da aprovação, você recebe o link de pagamento.',
      ...assinatura(),
    ];

    return this.enviar(
      orcamento,
      `Orçamento OS ${orcamento.codigoOS} - Oficina SOAT`,
      texto,
      'orcamento',
    );
  }

  enviarLinkPagamento(orcamento: Orcamento): Promise<void> {
    if (!orcamento.cobranca) return Promise.resolve();

    const texto = [
      `Olá ${orcamento.cliente.nome},`,
      '',
      `O orçamento da Ordem de Serviço ${orcamento.codigoOS} foi aprovado.`,
      `Total: ${moeda.format(orcamento.valorTotal)}`,
      '',
      'Pague pelo link abaixo (Mercado Pago), válido até',
      `${dataHora.format(orcamento.cobranca.expiraEm)} (horário de Brasília):`,
      orcamento.cobranca.linkPagamento,
      '',
      'Assim que o pagamento for confirmado, o reparo do veículo começa.',
      ...assinatura(),
    ];

    return this.enviar(
      orcamento,
      `Pagamento da OS ${orcamento.codigoOS} - Oficina SOAT`,
      texto,
      'link_pagamento',
    );
  }

  private async enviar(
    orcamento: Orcamento,
    assunto: string,
    linhas: string[],
    tipo: string,
  ): Promise<void> {
    const destino = orcamento.cliente.email;
    const atributos = { tipo_email: tipo, orcamento_id: orcamento.id };

    if (!destino || !this.config.url || !this.config.token) {
      registrarEvento('notificacao.nao_enviada', {
        ...atributos,
        razao: destino ? 'lambda_nao_configurada' : 'cliente_sem_email',
      });
      return;
    }

    try {
      const resposta = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mail-api-token': this.config.token,
        },
        body: JSON.stringify({
          to: destino,
          subject: assunto,
          text: linhas.join('\n'),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!resposta.ok) {
        throw new Error(`Lambda de e-mail respondeu HTTP ${resposta.status}`);
      }
      registrarEvento('notificacao.enviada', atributos);
    } catch (erro) {
      registrarFalha('notificacao.falhou', erro, atributos);
    }
  }
}

function secao(titulo: string, linhas: LinhaOrcamento[]): string[] {
  if (linhas.length === 0) return [];
  return [
    `${titulo}:`,
    ...linhas.map(
      (l) => `  - ${l.nome} (x${l.quantidade}): ${moeda.format(l.subtotal)}`,
    ),
    '',
  ];
}

function assinatura(): string[] {
  return ['', 'Atenciosamente,', 'Oficina SOAT'];
}
