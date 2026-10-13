export const STATUS_PAGAMENTO = ['APROVADO', 'RECUSADO', 'ESTORNADO'] as const;
export type StatusPagamento = (typeof STATUS_PAGAMENTO)[number];

/**
 * Um pagamento feito pelo link do orçamento, como o Mercado Pago informou.
 *
 * O `id` é o id do pagamento no Mercado Pago: o webhook repete avisos, e a
 * chave primária garante que cada pagamento é tratado uma vez só. Um orçamento
 * pode ter mais de um pagamento (uma tentativa recusada antes de outra, ou um
 * pagamento que chegou depois do cancelamento e foi estornado).
 */
export interface Pagamento {
  id: string;
  orcamentoId: string;
  osId: string;
  status: StatusPagamento;
  valor: number;
  /** status_detail do Mercado Pago, por exemplo `accredited` ou `cc_rejected_other_reason`. */
  detalhe: string | null;
  registradoEm: Date;
  pagoEm: Date | null;
  estornadoEm: Date | null;
  motivoEstorno: string | null;
}
