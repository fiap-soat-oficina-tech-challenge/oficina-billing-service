import { registrarEvento } from '../../../../common/observability';
import type { Cobranca, Orcamento } from '../../domain/orcamento';
import {
  GatewayPagamentoError,
  type GatewayPagamento,
  type PagamentoNoGateway,
} from '../../application/ports/gateway-pagamento';

export interface ConfiguracaoMercadoPago {
  /** https://api.mercadopago.com, ou o simulador nos testes locais e no BDD. */
  apiUrl: string;
  accessToken: string;
  /**
   * `external_id` do caixa (POS) a que as orders ficam ligadas. O caixa e a
   * loja são criados uma vez na conta do vendedor (README, "Mercado Pago").
   */
  caixaId: string;
}

/** Timeout de cada chamada (docs/contratos.md): abaixo do visibility timeout da fila. */
export const TIMEOUT_MS = 10_000;
/**
 * Uma chamada e uma nova tentativa. Com duas tentativas de 10 s, a aprovação
 * responde antes dos 30 s do API Gateway mesmo no pior caso.
 */
export const TENTATIVAS = 2;

interface OrderMP {
  id: string;
  status: string;
  status_detail?: string | null;
  external_reference?: string | null;
  total_amount: string;
  total_paid_amount?: string | null;
  last_updated_date?: string | null;
  type_response?: { qr_data?: string | null } | null;
}

/** 404 do Mercado Pago. */
class RespostaNaoEncontrada extends GatewayPagamentoError {
  constructor(operacao: string) {
    super(operacao, 'HTTP 404');
  }
}

/** 4xx que não se resolve repetindo; guarda os códigos de erro do corpo. */
class RespostaRecusada extends GatewayPagamentoError {
  constructor(
    operacao: string,
    readonly status: number,
    readonly codigos: string[],
  ) {
    super(
      operacao,
      `HTTP ${status}${codigos.length ? ` (${codigos.join(', ')})` : ''}`,
    );
  }
}

/**
 * Adaptador do Mercado Pago (QR Code dinâmico), pela Orders API.
 *
 * - Cobrança: `POST /v1/orders` com `type: qr` e `config.qr.mode: dynamic`, no
 *   caixa configurado; `external_reference` = id do orçamento. O QR Code vem em
 *   `type_response.qr_data`.
 * - Cancelamento: `POST /v1/orders/{id}/cancel`, que só vale para order ainda
 *   não paga.
 * - Consulta: `GET /v1/orders/{id}` — é daqui, e não do aviso do webhook, que
 *   vêm a situação e o valor.
 * - Estorno: `POST /v1/orders/{id}/refund`, sem corpo (estorno total).
 *
 * Toda escrita leva `X-Idempotency-Key` fixa por orçamento ou por order: uma
 * nova tentativa (aqui, ou a de uma mensagem que voltou para a fila) nunca cria
 * duas cobranças nem estorna duas vezes.
 *
 * Timeout e nova tentativa em falhas transitórias (rede, 429 e 5xx). Um 4xx não
 * é repetido: é pedido errado ou credencial inválida, e repetir não resolve.
 */
export class MercadoPagoGateway implements GatewayPagamento {
  constructor(
    private readonly config: ConfiguracaoMercadoPago,
    private readonly esperaEntreTentativasMs = 500,
  ) {}

  async criarCobranca(
    orcamento: Orcamento,
    prazoEmHoras: number,
    agora: Date,
  ): Promise<Cobranca> {
    const valor = orcamento.valorTotal.toFixed(2);
    const order = await this.chamar<OrderMP>(
      'criar a cobrança',
      'POST',
      '/v1/orders',
      {
        type: 'qr',
        total_amount: valor,
        description: `Orçamento da OS ${orcamento.codigoOS} - Oficina SOAT`,
        external_reference: orcamento.id,
        expiration_time: `PT${prazoEmHoras}H`,
        config: {
          qr: { external_pos_id: this.config.caixaId, mode: 'dynamic' },
        },
        transactions: { payments: [{ amount: valor }] },
      },
      { 'X-Idempotency-Key': `cobranca-${orcamento.id}` },
    );

    const qrCode = order.type_response?.qr_data;
    if (!qrCode) {
      throw new GatewayPagamentoError(
        'criar a cobrança',
        'resposta sem type_response.qr_data',
      );
    }

    return {
      id: order.id,
      qrCode,
      expiraEm: new Date(agora.getTime() + prazoEmHoras * 60 * 60 * 1000),
    };
  }

  async cancelarCobranca(cobrancaId: string): Promise<void> {
    try {
      await this.chamar(
        'cancelar a cobrança',
        'POST',
        `/v1/orders/${encodeURIComponent(cobrancaId)}/cancel`,
        undefined,
        { 'X-Idempotency-Key': `cancelamento-${cobrancaId}` },
      );
    } catch (erro) {
      // Paga, expirada ou já cancelada: a order já não aceita pagamento. Outro
      // 409 (como `instore_order_locked_error`, com um pagamento em andamento)
      // é repetido mais tarde, com a mensagem voltando para a fila.
      if (
        erro instanceof RespostaRecusada &&
        erro.codigos.includes('cannot_cancel_order')
      ) {
        registrarEvento('mercado_pago.cobranca_ja_encerrada', {
          cobranca_id: cobrancaId,
        });
        return;
      }
      throw erro;
    }
  }

  async consultarPagamento(
    cobrancaId: string,
  ): Promise<PagamentoNoGateway | null> {
    let order: OrderMP;
    try {
      order = await this.buscarOrder(cobrancaId);
    } catch (erro) {
      // 404, ou 400 para um id fora do formato (o aviso simulado do painel
      // manda `123456`): a order não existe.
      if (
        erro instanceof RespostaNaoEncontrada ||
        (erro instanceof RespostaRecusada && erro.status === 400)
      ) {
        return null;
      }
      throw erro;
    }

    const paga = order.status === 'processed';
    return {
      id: order.id,
      situacao: paga ? 'APROVADO' : 'OUTRA',
      statusOriginal: order.status,
      detalhe: order.status_detail ?? null,
      orcamentoId: order.external_reference ?? null,
      valor: Number(order.total_paid_amount ?? order.total_amount),
      pagoEm:
        paga && order.last_updated_date
          ? new Date(order.last_updated_date)
          : null,
    };
  }

  async estornar(cobrancaId: string): Promise<{ estornadoEm: Date }> {
    try {
      await this.chamar(
        'estornar o pagamento',
        'POST',
        `/v1/orders/${encodeURIComponent(cobrancaId)}/refund`,
        undefined,
        { 'X-Idempotency-Key': `estorno-${cobrancaId}` },
      );
    } catch (erro) {
      // Passadas 24 h, a chave de idempotência expira e um estorno repetido
      // volta 409. Se a order já está estornada, o estorno foi feito.
      if (!(erro instanceof RespostaRecusada && erro.status === 409)) {
        throw erro;
      }
      const order = await this.buscarOrder(cobrancaId);
      if (order.status !== 'refunded') throw erro;
    }
    // A resposta do estorno não traz data; o estorno total é imediato.
    return { estornadoEm: new Date() };
  }

  private buscarOrder(cobrancaId: string): Promise<OrderMP> {
    return this.chamar<OrderMP>(
      'consultar a cobrança',
      'GET',
      `/v1/orders/${encodeURIComponent(cobrancaId)}`,
    );
  }

  /**
   * Uma chamada à API com timeout e nova tentativa. A falha que sobra depois
   * das tentativas vira GatewayPagamentoError.
   */
  private async chamar<T>(
    operacao: string,
    metodo: 'GET' | 'POST',
    caminho: string,
    corpo?: unknown,
    cabecalhos: Record<string, string> = {},
  ): Promise<T> {
    let falha = '';

    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
      if (tentativa > 1) await esperar(this.esperaEntreTentativasMs);

      let resposta: Response;
      try {
        resposta = await fetch(`${this.config.apiUrl}${caminho}`, {
          method: metodo,
          headers: {
            Authorization: `Bearer ${this.config.accessToken}`,
            'Content-Type': 'application/json',
            ...cabecalhos,
          },
          body: corpo === undefined ? undefined : JSON.stringify(corpo),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (erro) {
        falha = erro instanceof Error ? erro.name : String(erro);
        this.registrarTentativa(operacao, tentativa, falha);
        continue;
      }

      if (resposta.ok) return (await resposta.json()) as T;
      if (resposta.status === 404) throw new RespostaNaoEncontrada(operacao);

      falha = `HTTP ${resposta.status}`;
      this.registrarTentativa(operacao, tentativa, falha);
      if (!transitorio(resposta.status)) {
        throw new RespostaRecusada(
          operacao,
          resposta.status,
          await codigosDeErro(resposta),
        );
      }
    }

    throw new GatewayPagamentoError(operacao, falha);
  }

  private registrarTentativa(
    operacao: string,
    tentativa: number,
    falha: string,
  ): void {
    registrarEvento(
      'mercado_pago.chamada_falhou',
      { operacao, tentativa, falha },
      'warn',
    );
  }
}

function transitorio(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Os `errors[].code` do corpo de erro da Orders API, se houver. */
async function codigosDeErro(resposta: Response): Promise<string[]> {
  try {
    const corpo = (await resposta.json()) as {
      errors?: { code?: unknown }[];
    };
    return (corpo.errors ?? [])
      .map((erro) => erro.code)
      .filter((codigo): codigo is string => typeof codigo === 'string');
  } catch {
    return [];
  }
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}
