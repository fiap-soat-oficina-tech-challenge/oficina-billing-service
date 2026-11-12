import type { Pagamento } from '../pagamento';

export const PAGAMENTO_REPOSITORY = Symbol('PAGAMENTO_REPOSITORY');

export interface PagamentoRepository {
  /** Grava o pagamento. Falha se o id (o do Mercado Pago) já existir. */
  registrar(pagamento: Pagamento): Promise<void>;

  buscarPorId(id: string): Promise<Pagamento | null>;

  /** Pagamentos da OS, mais antigos primeiro. */
  listarPorOs(osId: string): Promise<Pagamento[]>;

  /** O pagamento aprovado (ainda não estornado) da OS, se houver. */
  buscarAprovadoDaOs(osId: string): Promise<Pagamento | null>;

  /**
   * Marca como estornado só se ainda estiver APROVADO; devolve false se outro
   * estorno chegou antes.
   */
  marcarEstornado(
    id: string,
    estornadoEm: Date,
    motivoEstorno: string,
  ): Promise<boolean>;
}
