export class OrcamentoNaoEncontradoError extends Error {
  constructor(referencia: string) {
    super(`Orçamento ${referencia} não encontrado`);
    this.name = 'OrcamentoNaoEncontradoError';
  }
}

export class TransicaoInvalidaError extends Error {
  constructor(status: string, acao: string) {
    super(`Não é possível ${acao} um orçamento com status ${status}`);
    this.name = 'TransicaoInvalidaError';
  }
}

/** O orçamento mudou entre a leitura e a gravação (outra ação chegou antes). */
export class OrcamentoAlteradoError extends Error {
  constructor(id: string) {
    super(
      `O orçamento ${id} foi alterado por outra ação; consulte e tente de novo`,
    );
    this.name = 'OrcamentoAlteradoError';
  }
}

/** O pagamento mudou entre a leitura e a gravação (outro estorno chegou antes). */
export class PagamentoAlteradoError extends Error {
  constructor(id: string) {
    super(`O pagamento ${id} foi alterado por outra ação`);
    this.name = 'PagamentoAlteradoError';
  }
}
