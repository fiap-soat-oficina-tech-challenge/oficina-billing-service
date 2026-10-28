import type { Envelope } from '../../../../common/mensageria/envelope';

export const PUBLICADOR_RESPOSTAS = Symbol('PUBLICADOR_RESPOSTAS');

/** Publica as respostas da Saga para o orquestrador (fila oficina-os-saga-replies). */
export interface PublicadorRespostas {
  publicar(envelope: Envelope<unknown>): Promise<void>;
}

/** Tipos de resposta publicados por este serviço (docs/contratos.md). */
export const RESPOSTAS = {
  orcamentoEnviado: 'OrcamentoEnviado',
  geracaoOrcamentoFalhou: 'GeracaoOrcamentoFalhou',
  orcamentoAprovado: 'OrcamentoAprovado',
  orcamentoRecusado: 'OrcamentoRecusado',
  pagamentoConfirmado: 'PagamentoConfirmado',
  pagamentoEstornado: 'PagamentoEstornado',
} as const;

/** Comandos consumidos por este serviço (fila oficina-billing-commands). */
export const COMANDOS = {
  gerarOrcamento: 'GerarOrcamento',
  cancelarOrcamento: 'CancelarOrcamento',
  estornarPagamento: 'EstornarPagamento',
} as const;
