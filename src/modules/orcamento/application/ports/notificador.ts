import type { Orcamento } from '../../domain/orcamento';

export const NOTIFICADOR = Symbol('NOTIFICADOR');

/**
 * Avisos ao cliente por e-mail. É best-effort, como na Fase 3: uma falha no
 * envio só é registrada no log e nunca desfaz nem bloqueia a operação. Sem
 * e-mail no cadastro, nada é enviado e o cliente consulta pela API.
 */
export interface Notificador {
  /** O orçamento gerado, com o que fazer para aprovar ou recusar. */
  enviarOrcamento(orcamento: Orcamento): Promise<void>;

  /** O link de pagamento, depois da aprovação. */
  enviarLinkPagamento(orcamento: Orcamento): Promise<void>;
}
