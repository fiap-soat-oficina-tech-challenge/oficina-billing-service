import {
  registrarEvento,
  registrarFalha,
} from '../../../../common/observability';
import type { Notificador } from '../../application/ports/notificador';
import type { LinhaOrcamento, Orcamento } from '../../domain/orcamento';
import { gerarImagemQrCode } from '../qr-code/imagem-qr-code';

export interface ConfiguracaoEmail {
  /** Rota `/mail` da Lambda de notificações (API Gateway). */
  url?: string;
  /** Header `x-mail-api-token` exigido pela Lambda. */
  token?: string;
}

const TIMEOUT_MS = 15_000;

/** O HTML do e-mail mostra a imagem anexada por este id (`<img src="cid:...">`). */
export const CID_QR_CODE = 'qrcode-pagamento';

/** Imagem embutida no e-mail, no formato da Lambda (`attachments`). */
interface Anexo {
  filename: string;
  contentType: string;
  content: string;
  cid: string;
}

interface Email {
  assunto: string;
  linhas: string[];
  html?: string;
  anexos?: Anexo[];
}

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
      'Depois da aprovação, você recebe o QR Code de pagamento.',
      ...assinatura(),
    ];

    return this.enviar(orcamento, 'orcamento', () =>
      Promise.resolve({
        assunto: `Orçamento OS ${orcamento.codigoOS} - Oficina SOAT`,
        linhas: texto,
      }),
    );
  }

  /**
   * O QR Code vai como imagem embutida no HTML. A versão em texto, para leitores
   * de e-mail que não mostram imagens, aponta para a consulta do orçamento na
   * API, que também traz o QR Code.
   */
  enviarCobranca(orcamento: Orcamento): Promise<void> {
    const cobranca = orcamento.cobranca;
    if (!cobranca) return Promise.resolve();

    const total = moeda.format(orcamento.valorTotal);
    const validade = `${dataHora.format(cobranca.expiraEm)} (horário de Brasília)`;

    return this.enviar(orcamento, 'cobranca', async () => {
      const imagem = await gerarImagemQrCode(cobranca.qrCode);
      return {
        assunto: `Pagamento da OS ${orcamento.codigoOS} - Oficina SOAT`,
        linhas: [
          `Olá ${orcamento.cliente.nome},`,
          '',
          `O orçamento da Ordem de Serviço ${orcamento.codigoOS} foi aprovado.`,
          `Total: ${total}`,
          '',
          'Pague pelo QR Code com o app do Mercado Pago, até',
          `${validade}. O QR Code está na versão em HTML deste e-mail e na`,
          `consulta do orçamento: GET /billing/orcamentos/${orcamento.id}`,
          '',
          'Se o pagamento for recusado, é só pagar de novo pelo mesmo QR Code.',
          'Assim que o pagamento for confirmado, o reparo do veículo começa.',
          ...assinatura(),
        ],
        html: [
          `<p>Olá ${html(orcamento.cliente.nome)},</p>`,
          `<p>O orçamento da Ordem de Serviço <strong>${html(orcamento.codigoOS)}</strong> foi aprovado.<br>`,
          `Total: <strong>${total}</strong></p>`,
          `<p>Pague pelo QR Code abaixo com o app do Mercado Pago, até ${validade}:</p>`,
          `<p><img src="cid:${CID_QR_CODE}" alt="QR Code de pagamento" width="300" height="300"></p>`,
          '<p>Se o pagamento for recusado, é só pagar de novo pelo mesmo QR Code. ',
          'Assim que o pagamento for confirmado, o reparo do veículo começa.</p>',
          '<p>Atenciosamente,<br>Oficina SOAT</p>',
        ].join('\n'),
        anexos: [
          {
            filename: 'qrcode-pagamento.png',
            contentType: 'image/png',
            content: imagem.toString('base64'),
            cid: CID_QR_CODE,
          },
        ],
      };
    });
  }

  /**
   * Monta e envia o e-mail. A montagem fica dentro do try: uma falha ali (na
   * imagem do QR Code, por exemplo) também só vai para o log.
   */
  private async enviar(
    orcamento: Orcamento,
    tipo: string,
    montar: () => Promise<Email>,
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
      const email = await montar();
      const resposta = await fetch(this.config.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mail-api-token': this.config.token,
        },
        body: JSON.stringify({
          to: destino,
          subject: email.assunto,
          text: email.linhas.join('\n'),
          html: email.html,
          attachments: email.anexos,
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

/** Escapa texto que vem de fora (nome do cliente, código da OS) para o HTML. */
function html(texto: string): string {
  return texto
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
