import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../auth/domain/types';
import { OrcamentoNaoEncontradoError } from '../../domain/errors';
import type { Orcamento } from '../../domain/orcamento';
import type { Pagamento } from '../../domain/pagamento';
import {
  ORCAMENTO_REPOSITORY,
  type OrcamentoRepository,
} from '../../domain/repository/orcamento.repository';
import {
  PAGAMENTO_REPOSITORY,
  type PagamentoRepository,
} from '../../domain/repository/pagamento.repository';
import { traduzirErroDominio } from '../shared/traduzir-erro-dominio';

/**
 * Consultas de orçamentos e pagamentos. O funcionário vê tudo; o cliente só o
 * que é dele — o orçamento de outro cliente se comporta como inexistente (404 ou
 * lista vazia), como nas rotas `/ordens-servico/minhas` do OS Service.
 */
@Injectable()
export class ConsultarOrcamentosUseCase {
  constructor(
    @Inject(ORCAMENTO_REPOSITORY)
    private readonly orcamentos: OrcamentoRepository,
    @Inject(PAGAMENTO_REPOSITORY)
    private readonly pagamentos: PagamentoRepository,
  ) {}

  /** Orçamentos da OS (uma OS tem no máximo um). */
  async listarDaOs(
    osId: string,
    usuario: AuthenticatedUser,
  ): Promise<Orcamento[]> {
    const orcamento = await this.orcamentos.buscarPorOs(osId);
    return orcamento && podeVer(usuario, orcamento) ? [orcamento] : [];
  }

  async buscar(id: string, usuario: AuthenticatedUser): Promise<Orcamento> {
    try {
      const orcamento = await this.orcamentos.buscarPorId(id);
      if (!orcamento || !podeVer(usuario, orcamento)) {
        throw new OrcamentoNaoEncontradoError(id);
      }
      return orcamento;
    } catch (erro) {
      throw traduzirErroDominio(erro);
    }
  }

  /** Pagamentos e estornos da OS (rota do funcionário). */
  listarPagamentosDaOs(osId: string): Promise<Pagamento[]> {
    return this.pagamentos.listarPorOs(osId);
  }
}

function podeVer(usuario: AuthenticatedUser, orcamento: Orcamento): boolean {
  return usuario.tipo === 'admin' || orcamento.cliente.id === usuario.id;
}
