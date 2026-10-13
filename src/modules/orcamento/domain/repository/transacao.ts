import type { OrcamentoRepository } from './orcamento.repository';
import type { PagamentoRepository } from './pagamento.repository';

export const TRANSACAO = Symbol('TRANSACAO');

/** Repositórios ligados à mesma transação do banco. */
export interface RepositoriosDaTransacao {
  orcamentos: OrcamentoRepository;
  pagamentos: PagamentoRepository;
}

/**
 * Gravar e publicar na mesma transação (docs/contratos.md, seção 1).
 *
 * O trabalho recebe repositórios ligados a uma transação e publica a mensagem
 * dentro dela, depois das gravações. Se qualquer passo lançar erro — inclusive a
 * publicação —, a transação é desfeita e nada fica gravado sem a mensagem
 * correspondente. É a alternativa enxuta ao outbox transacional.
 */
export interface Transacao {
  executar<T>(
    trabalho: (repositorios: RepositoriosDaTransacao) => Promise<T>,
  ): Promise<T>;
}
