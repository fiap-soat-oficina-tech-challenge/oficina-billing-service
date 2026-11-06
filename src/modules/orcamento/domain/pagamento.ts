export const STATUS_PAGAMENTO = ['APROVADO', 'ESTORNADO'] as const;
export type StatusPagamento = (typeof STATUS_PAGAMENTO)[number];

/**
 * O pagamento da cobrança do orçamento, como o Mercado Pago informou.
 *
 * O `id` é o da order paga no Mercado Pago (`ORD...`): o webhook repete avisos,
 * e a chave primária garante que cada pagamento é tratado uma vez só. Tentativas
 * recusadas não viram registro: a order continua aberta, o Mercado Pago não as
 * avisa e o cliente paga de novo pelo mesmo QR Code.
 */
export interface Pagamento {
  id: string;
  orcamentoId: string;
  osId: string;
  status: StatusPagamento;
  valor: number;
  /** status_detail da order no Mercado Pago, por exemplo `accredited`. */
  detalhe: string | null;
  registradoEm: Date;
  pagoEm: Date | null;
  estornadoEm: Date | null;
  motivoEstorno: string | null;
}
