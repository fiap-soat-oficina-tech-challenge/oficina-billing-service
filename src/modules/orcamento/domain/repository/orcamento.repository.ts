import type { Orcamento, StatusOrcamento } from '../orcamento';

export const ORCAMENTO_REPOSITORY = Symbol('ORCAMENTO_REPOSITORY');

export type MudancasOrcamento = Pick<Orcamento, 'status' | 'atualizadoEm'> &
  Partial<
    Pick<
      Orcamento,
      | 'origemDecisao'
      | 'motivoRecusa'
      | 'motivoCancelamento'
      | 'cobranca'
      | 'decididoEm'
      | 'pagoEm'
      | 'canceladoEm'
    >
  >;

export interface OrcamentoRepository {
  /** Grava o orçamento com as linhas. Falha se a OS já tiver orçamento. */
  criar(orcamento: Orcamento): Promise<void>;

  buscarPorId(id: string): Promise<Orcamento | null>;

  /** O orçamento da OS (uma OS tem um só orçamento). */
  buscarPorOs(osId: string): Promise<Orcamento | null>;

  buscarPorCodigoOS(codigoOS: string): Promise<Orcamento | null>;

  /**
   * Aplica as mudanças só se o status ainda for `statusAtual`; devolve false se
   * outra ação mudou o orçamento antes.
   */
  atualizar(
    id: string,
    statusAtual: StatusOrcamento,
    mudancas: MudancasOrcamento,
  ): Promise<boolean>;
}
