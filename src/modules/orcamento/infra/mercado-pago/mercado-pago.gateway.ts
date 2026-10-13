import { registrarEvento } from '../../../../common/observability';
import type { Cobranca, Orcamento } from '../../domain/orcamento';
import {
  GatewayPagamentoError,
  type GatewayPagamento,
  type PagamentoNoGateway,
  type SituacaoPagamento,
} from '../../application/ports/gateway-pagamento';

export interface ConfiguracaoMercadoPago {
  /** https://api.mercadopago.com, ou o simulador nos testes locais e no BDD. */
  apiUrl: string;
  accessToken: string;
  /** URL pública do webhook (API Gateway). Sem ela, o Mercado Pago não avisa. */
  notificationUrl?: string;
  /** Com credenciais de teste, o link a usar é o `sandbox_init_point`. */
  usarSandbox: boolean;
}

/** Timeout de cada chamada (docs/contratos.md): abaixo do visibility timeout da fila. */
export const TIMEOUT_MS = 10_000;
/**
 * Uma chamada e uma nova tentativa. Com duas tentativas de 10 s, a aprovação
 * responde antes dos 30 s do API Gateway mesmo no pior caso.
 */
export const TENTATIVAS = 2;

interface PreferenciaMP {
  id: string;
  init_point: string;
  sandbox_init_point: string;
}

interface PagamentoMP {
  id: number | string;
  status: string;
  status_detail?: string | null;
  external_reference?: string | null;
  transaction_amount: number;
  date_approved?: string | null;
}

interface EstornoMP {
  date_created?: string | null;
}

/** 404 do Mercado Pago: só a consulta de pagamento trata como "não existe". */
class RespostaNaoEncontrada extends GatewayPagamentoError {
  constructor(operacao: string) {
    super(operacao, 'HTTP 404');
  }
}

/**
 * Adaptador do Mercado Pago (Checkout Pro), pela API REST.
 *
 * - Cobrança: `POST /checkout/preferences`, com `external_reference` = id do
 *   orçamento e prazo de expiração; o cliente paga pelo link devolvido.
 * - Expiração: `PUT /checkout/preferences/{id}` com o prazo no passado.
 * - Consulta: `GET /v1/payments/{id}` — é daqui, e não do aviso do webhook,
 *   que vêm a situação e o valor do pagamento.
 * - Estorno: `POST /v1/payments/{id}/refunds`, com `X-Idempotency-Key` fixa por
 *   pagamento, para uma nova tentativa nunca estornar duas vezes.
 *
 * Timeout e nova tentativa em falhas transitórias (rede, 429 e 5xx). Um 4xx não
 * é repetido: é pedido errado ou credencial inválida, e repetir não resolve.
 */
export class MercadoPagoGateway implements GatewayPagamento {
  constructor(
    private readonly config: ConfiguracaoMercadoPago,
    private readonly esperaEntreTentativasMs = 500,
  ) {}

  async criarCobranca(orcamento: Orcamento, expiraEm: Date): Promise<Cobranca> {
    const preferencia = await this.chamar<PreferenciaMP>(
      'criar o link de pagamento',
      'POST',
      '/checkout/preferences',
      {
        items: [
          {
            id: orcamento.id,
            title: `Orçamento da OS ${orcamento.codigoOS} - Oficina SOAT`,
            quantity: 1,
            unit_price: orcamento.valorTotal,
            currency_id: 'BRL',
          },
        ],
        external_reference: orcamento.id,
        notification_url: this.config.notificationUrl,
        expires: true,
        expiration_date_to: dataMercadoPago(expiraEm),
      },
    );

    return {
      preferenciaId: preferencia.id,
      linkPagamento: this.config.usarSandbox
        ? preferencia.sandbox_init_point
        : preferencia.init_point,
      expiraEm,
    };
  }

  async expirarCobranca(preferenciaId: string, agora: Date): Promise<void> {
    // Um minuto no passado: o relógio do Mercado Pago pode estar um pouco atrás
    // do nosso, e o link precisa parar de aceitar pagamento já.
    const passado = new Date(agora.getTime() - 60_000);
    await this.chamar(
      'expirar o link de pagamento',
      'PUT',
      `/checkout/preferences/${encodeURIComponent(preferenciaId)}`,
      { expires: true, expiration_date_to: dataMercadoPago(passado) },
    );
  }

  async consultarPagamento(
    pagamentoId: string,
  ): Promise<PagamentoNoGateway | null> {
    let pagamento: PagamentoMP;
    try {
      pagamento = await this.chamar<PagamentoMP>(
        'consultar o pagamento',
        'GET',
        `/v1/payments/${encodeURIComponent(pagamentoId)}`,
      );
    } catch (erro) {
      if (erro instanceof RespostaNaoEncontrada) return null;
      throw erro;
    }

    return {
      id: String(pagamento.id),
      situacao: traduzirStatus(pagamento.status),
      statusOriginal: pagamento.status,
      detalhe: pagamento.status_detail ?? null,
      orcamentoId: pagamento.external_reference ?? null,
      valor: pagamento.transaction_amount,
      pagoEm: pagamento.date_approved
        ? new Date(pagamento.date_approved)
        : null,
    };
  }

  async estornar(pagamentoId: string): Promise<{ estornadoEm: Date }> {
    const estorno = await this.chamar<EstornoMP>(
      'estornar o pagamento',
      'POST',
      `/v1/payments/${encodeURIComponent(pagamentoId)}/refunds`,
      {},
      { 'X-Idempotency-Key': `estorno-${pagamentoId}` },
    );
    return {
      estornadoEm: estorno.date_created
        ? new Date(estorno.date_created)
        : new Date(),
    };
  }

  /**
   * Uma chamada à API com timeout e nova tentativa. A falha que sobra depois
   * das tentativas vira GatewayPagamentoError.
   */
  private async chamar<T>(
    operacao: string,
    metodo: 'GET' | 'POST' | 'PUT',
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
      if (!transitorio(resposta.status)) break;
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

function traduzirStatus(status: string): SituacaoPagamento {
  if (status === 'approved') return 'APROVADO';
  if (status === 'rejected') return 'RECUSADO';
  return 'OUTRA';
}

/** Data no formato que o Mercado Pago documenta: `2026-10-20T14:03:00.000+00:00`. */
function dataMercadoPago(data: Date): string {
  return data.toISOString().replace('Z', '+00:00');
}

function esperar(ms: number): Promise<void> {
  return new Promise((resolver) => setTimeout(resolver, ms));
}
