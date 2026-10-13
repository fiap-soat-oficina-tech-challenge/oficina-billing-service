import type { OrcamentoResponseDto } from '../../application/dto/orcamento.dto';
import type { Orcamento } from '../../domain/orcamento';

/**
 * Formato do orçamento nas respostas da API. As linhas voltam com o nome do id
 * usado no OS Service (`servicoId`, `itemEstoqueId`), como no comando
 * GerarOrcamento, e o link de pagamento fica no primeiro nível.
 */
export function apresentarOrcamento(
  orcamento: Orcamento,
): OrcamentoResponseDto {
  const { servicos, itens, cobranca, ...resto } = orcamento;
  return {
    ...resto,
    servicos: servicos.map(({ referenciaId, ...linha }) => ({
      servicoId: referenciaId,
      ...linha,
    })),
    itens: itens.map(({ referenciaId, ...linha }) => ({
      itemEstoqueId: referenciaId,
      ...linha,
    })),
    linkPagamento: cobranca?.linkPagamento ?? null,
    linkExpiraEm: cobranca?.expiraEm ?? null,
  };
}
