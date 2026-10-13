import { TransicaoInvalidaError } from './errors';

export const STATUS_ORCAMENTO = [
  'AGUARDANDO_APROVACAO',
  'APROVADO',
  'RECUSADO',
  'PAGO',
  'CANCELADO',
] as const;
export type StatusOrcamento = (typeof STATUS_ORCAMENTO)[number];

/** Quem aprovou ou recusou: o cliente pela API ou o sistema externo pelo webhook. */
export const ORIGENS_DECISAO = ['CLIENTE', 'SISTEMA_EXTERNO'] as const;
export type OrigemDecisao = (typeof ORIGENS_DECISAO)[number];

export type AcaoOrcamento = 'aprovar' | 'recusar' | 'pagar' | 'cancelar';

/** Uma linha do orçamento: um serviço ou um item (peça ou insumo) da OS. */
export interface LinhaOrcamento {
  /** servicoId ou itemEstoqueId no OS Service, só para rastreio. */
  referenciaId: string;
  nome: string;
  precoUnitario: number;
  quantidade: number;
  subtotal: number;
}

export interface ClienteDoOrcamento {
  id: string;
  nome: string;
  /** O cadastro do OS não exige e-mail; sem ele, nenhum e-mail é enviado. */
  email: string | null;
}

/** Link de pagamento do Mercado Pago (Checkout Pro), criado na aprovação. */
export interface Cobranca {
  preferenciaId: string;
  linkPagamento: string;
  expiraEm: Date;
}

/**
 * O orçamento de uma OS. Cliente, serviços, itens e preços são a cópia que
 * chega no comando GerarOrcamento: este serviço nunca consulta o banco do OS
 * Service.
 */
export interface Orcamento {
  id: string;
  osId: string;
  codigoOS: string;
  /** Fluxo da OS: vai em toda resposta publicada a partir deste orçamento. */
  correlationId: string;
  cliente: ClienteDoOrcamento;
  servicos: LinhaOrcamento[];
  itens: LinhaOrcamento[];
  valorServicos: number;
  valorPecas: number;
  valorTotal: number;
  status: StatusOrcamento;
  origemDecisao: OrigemDecisao | null;
  motivoRecusa: string | null;
  motivoCancelamento: string | null;
  cobranca: Cobranca | null;
  criadoEm: Date;
  atualizadoEm: Date;
  decididoEm: Date | null;
  pagoEm: Date | null;
  canceladoEm: Date | null;
}

const TRANSICOES: Record<
  AcaoOrcamento,
  Partial<Record<StatusOrcamento, StatusOrcamento>>
> = {
  aprovar: { AGUARDANDO_APROVACAO: 'APROVADO' },
  recusar: { AGUARDANDO_APROVACAO: 'RECUSADO' },
  pagar: { APROVADO: 'PAGO' },
  cancelar: {
    AGUARDANDO_APROVACAO: 'CANCELADO',
    APROVADO: 'CANCELADO',
    PAGO: 'CANCELADO',
  },
};

/**
 * Ciclo de um orçamento:
 *
 *   AGUARDANDO_APROVACAO → APROVADO → PAGO
 *   AGUARDANDO_APROVACAO → RECUSADO
 *   AGUARDANDO_APROVACAO, APROVADO ou PAGO → CANCELADO (compensação da Saga)
 *
 * Um orçamento PAGO só é cancelado junto com o estorno do pagamento. RECUSADO e
 * CANCELADO são finais.
 */
export function proximoStatus(
  atual: StatusOrcamento,
  acao: AcaoOrcamento,
): StatusOrcamento {
  const proximo = TRANSICOES[acao][atual];
  if (!proximo) throw new TransicaoInvalidaError(atual, acao);
  return proximo;
}
