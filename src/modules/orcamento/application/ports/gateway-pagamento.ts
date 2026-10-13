import type { Cobranca, Orcamento } from '../../domain/orcamento';

export const GATEWAY_PAGAMENTO = Symbol('GATEWAY_PAGAMENTO');

/**
 * Situação de um pagamento no gateway, já traduzida para o que interessa à
 * Saga. Qualquer outra situação (pendente, em análise, estornado...) é OUTRA e
 * não muda nada aqui: o Mercado Pago avisa de novo quando o pagamento for
 * aprovado ou recusado.
 */
export type SituacaoPagamento = 'APROVADO' | 'RECUSADO' | 'OUTRA';

export interface PagamentoNoGateway {
  id: string;
  situacao: SituacaoPagamento;
  /** Status original do gateway, para os logs (ex.: `in_process`). */
  statusOriginal: string;
  detalhe: string | null;
  /** O orçamento a que o pagamento se refere (`external_reference`). */
  orcamentoId: string | null;
  valor: number;
  pagoEm: Date | null;
}

/**
 * O Mercado Pago não atendeu (fora do ar, timeout, erro 5xx depois das novas
 * tentativas, ou pedido recusado). Na aprovação vira 503: nada muda e quem
 * chamou tenta de novo. No consumo de um comando, devolve a mensagem para a
 * fila; no webhook, faz o Mercado Pago reenviar o aviso.
 */
export class GatewayPagamentoError extends Error {
  constructor(operacao: string, causa: string) {
    super(`Falha no Mercado Pago ao ${operacao}: ${causa}`);
    this.name = 'GatewayPagamentoError';
  }
}

/** Cobrança, consulta e estorno no gateway de pagamento (Mercado Pago). */
export interface GatewayPagamento {
  /** Cria o link de pagamento do orçamento, válido até `expiraEm`. */
  criarCobranca(orcamento: Orcamento, expiraEm: Date): Promise<Cobranca>;

  /** Faz o link deixar de aceitar pagamento. */
  expirarCobranca(preferenciaId: string, agora: Date): Promise<void>;

  /** O pagamento, ou null se o Mercado Pago não o conhece. */
  consultarPagamento(pagamentoId: string): Promise<PagamentoNoGateway | null>;

  /** Estorna o valor total. Repetir o estorno do mesmo pagamento não estorna duas vezes. */
  estornar(pagamentoId: string): Promise<{ estornadoEm: Date }>;
}
