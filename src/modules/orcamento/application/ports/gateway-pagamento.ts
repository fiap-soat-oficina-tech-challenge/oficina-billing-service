import type { Cobranca, Orcamento } from '../../domain/orcamento';

export const GATEWAY_PAGAMENTO = Symbol('GATEWAY_PAGAMENTO');

/**
 * Situação de uma cobrança no gateway, já traduzida para o que interessa à
 * Saga: APROVADO quando foi paga. Qualquer outra (aberta, cancelada, expirada,
 * estornada) é OUTRA e não muda nada aqui. Uma tentativa recusada não muda a
 * cobrança, que continua aberta para o cliente pagar de novo.
 */
export type SituacaoPagamento = 'APROVADO' | 'OUTRA';

/** Uma cobrança consultada no gateway: a order de QR Code no Mercado Pago. */
export interface PagamentoNoGateway {
  /** Id da order (`ORD...`). */
  id: string;
  situacao: SituacaoPagamento;
  /** Status original do gateway, para os logs (ex.: `created`, `expired`). */
  statusOriginal: string;
  detalhe: string | null;
  /** O orçamento a que a cobrança se refere (`external_reference`). */
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
  /**
   * Cria a cobrança do orçamento (QR Code), válida por `prazoEmHoras` a partir
   * de `agora`. Repetir para o mesmo orçamento devolve a mesma cobrança.
   */
  criarCobranca(
    orcamento: Orcamento,
    prazoEmHoras: number,
    agora: Date,
  ): Promise<Cobranca>;

  /**
   * Faz a cobrança deixar de aceitar pagamento. Uma cobrança que já não aceita
   * (paga, expirada ou cancelada) não é erro: se foi paga, o aviso do pagamento
   * chega pelo webhook e o estorno automático cuida dele.
   */
  cancelarCobranca(cobrancaId: string): Promise<void>;

  /** A cobrança, ou null se o Mercado Pago não a conhece. */
  consultarPagamento(cobrancaId: string): Promise<PagamentoNoGateway | null>;

  /** Estorna o valor total. Repetir o estorno da mesma cobrança não estorna duas vezes. */
  estornar(cobrancaId: string): Promise<{ estornadoEm: Date }>;
}
