import { EstornoDePagamento } from '../shared/estorno-de-pagamento';
import { CancelarOrcamentoUseCase } from './cancelar-orcamento.use-case';
import { EstornarPagamentoUseCase } from './estornar-pagamento.use-case';
import {
  AGORA,
  COBRANCA,
  criarCenario,
  envelopeDeComando,
  ORCAMENTO_ID,
  orcamentoDeExemplo,
  pagamentoDeExemplo,
} from './testes-de-apoio';
import type { StatusOrcamento } from '../../domain/orcamento';

/** Os dois comandos de compensação da Saga: CancelarOrcamento e EstornarPagamento. */
function montar(status: StatusOrcamento, comPagamentoAprovado = false) {
  const cenario = criarCenario();
  cenario.orcamentos.orcamentos.set(
    ORCAMENTO_ID,
    orcamentoDeExemplo({
      status,
      cobranca: status === 'AGUARDANDO_APROVACAO' ? null : COBRANCA,
    }),
  );
  if (comPagamentoAprovado) {
    cenario.pagamentos.pagamentos.set('1234567890', pagamentoDeExemplo());
  }
  const estorno = new EstornoDePagamento(
    cenario.gateway,
    cenario.transacao,
    cenario.publicador,
  );
  return {
    ...cenario,
    cancelar: new CancelarOrcamentoUseCase(
      cenario.orcamentos,
      cenario.pagamentos,
      cenario.gateway,
      estorno,
    ),
    estornar: new EstornarPagamentoUseCase(
      cenario.orcamentos,
      cenario.pagamentos,
      estorno,
    ),
  };
}

const cancelarOrcamento = (motivo?: string) =>
  envelopeDeComando('CancelarOrcamento', motivo ? { motivo } : {});
const estornarPagamento = (motivo?: string) =>
  envelopeDeComando('EstornarPagamento', motivo ? { motivo } : {});

describe('CancelarOrcamentoUseCase', () => {
  it('orçamento aguardando aprovação: cancela com o motivo, sem chamar o Mercado Pago', async () => {
    const { cancelar, orcamentos, gateway, publicador } = montar(
      'AGUARDANDO_APROVACAO',
    );

    await cancelar.execute(
      cancelarOrcamento('Cancelada pelo funcionário'),
      AGORA,
    );

    expect(await orcamentos.buscarPorId(ORCAMENTO_ID)).toMatchObject({
      status: 'CANCELADO',
      motivoCancelamento: 'Cancelada pelo funcionário',
      canceladoEm: AGORA,
    });
    expect(gateway.chamadas).toHaveLength(0);
    expect(publicador.publicadas).toHaveLength(0);
  });

  it('orçamento aprovado: expira o link de pagamento e cancela', async () => {
    const { cancelar, orcamentos, gateway } = montar('APROVADO');

    await cancelar.execute(
      cancelarOrcamento('Cliente desistiu do pagamento'),
      AGORA,
    );

    expect(gateway.chamadas).toEqual(['expirarCobranca:pref-1']);
    expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(
      'CANCELADO',
    );
  });

  it('Mercado Pago fora ao expirar o link: erro e o orçamento não muda (a fila repete)', async () => {
    const { cancelar, orcamentos, gateway } = montar('APROVADO');
    gateway.falha = new Error('Mercado Pago fora');

    await expect(cancelar.execute(cancelarOrcamento(), AGORA)).rejects.toThrow(
      'Mercado Pago fora',
    );
    expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(
      'APROVADO',
    );
  });

  it('orçamento já pago: estorna, cancela e responde PagamentoEstornado', async () => {
    const { cancelar, orcamentos, pagamentos, gateway, publicador } = montar(
      'PAGO',
      true,
    );

    await cancelar.execute(
      cancelarOrcamento('Cancelada pelo funcionário'),
      AGORA,
    );

    expect(gateway.chamadas).toEqual(['estornar:1234567890']);
    expect(await pagamentos.buscarPorId('1234567890')).toMatchObject({
      status: 'ESTORNADO',
      motivoEstorno: 'Cancelada pelo funcionário',
    });
    expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(
      'CANCELADO',
    );
    expect(publicador.publicadas[0]).toMatchObject({
      tipo: 'PagamentoEstornado',
      correlationId: 'fluxo-da-os',
      payload: { pagamentoId: '1234567890' },
    });
  });

  it('orçamento pago sem pagamento aprovado é inconsistência: erro para a DLQ', async () => {
    const { cancelar } = montar('PAGO');

    await expect(cancelar.execute(cancelarOrcamento(), AGORA)).rejects.toThrow(
      'sem pagamento aprovado',
    );
  });

  it.each(['RECUSADO', 'CANCELADO'] as const)(
    'orçamento %s: nada a fazer (comando repetido)',
    async (status) => {
      const { cancelar, orcamentos, gateway } = montar(status);

      await cancelar.execute(cancelarOrcamento(), AGORA);

      expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(status);
      expect(gateway.chamadas).toHaveLength(0);
    },
  );

  it('OS sem orçamento: nada a fazer', async () => {
    const { cancelar, orcamentos } = montar('AGUARDANDO_APROVACAO');
    orcamentos.orcamentos.clear();

    await expect(
      cancelar.execute(cancelarOrcamento(), AGORA),
    ).resolves.toBeUndefined();
  });

  it('pagamento chegou no meio do cancelamento: erro, e a nova tentativa cai no estorno', async () => {
    const { cancelar, orcamentos } = montar('AGUARDANDO_APROVACAO');
    jest.spyOn(orcamentos, 'atualizar').mockResolvedValueOnce(false);

    await expect(cancelar.execute(cancelarOrcamento(), AGORA)).rejects.toThrow(
      'alterado por outra ação',
    );
  });

  it('sem motivo no comando, usa NAO_INFORMADO', async () => {
    const { cancelar, orcamentos } = montar('AGUARDANDO_APROVACAO');

    await cancelar.execute(cancelarOrcamento(), AGORA);

    expect(
      (await orcamentos.buscarPorId(ORCAMENTO_ID))?.motivoCancelamento,
    ).toBe('NAO_INFORMADO');
  });
});

describe('EstornarPagamentoUseCase', () => {
  it('estorna o pagamento aprovado, cancela o orçamento e responde PagamentoEstornado', async () => {
    const { estornar, orcamentos, pagamentos, gateway, publicador } = montar(
      'PAGO',
      true,
    );

    await estornar.execute(
      estornarPagamento('Reparo falhou: peça indisponível'),
      AGORA,
    );

    expect(gateway.chamadas).toEqual(['estornar:1234567890']);
    expect(await pagamentos.buscarPorId('1234567890')).toMatchObject({
      status: 'ESTORNADO',
      motivoEstorno: 'Reparo falhou: peça indisponível',
    });
    expect(await orcamentos.buscarPorId(ORCAMENTO_ID)).toMatchObject({
      status: 'CANCELADO',
      motivoCancelamento: 'Reparo falhou: peça indisponível',
    });
    expect(publicador.tipos()).toEqual(['PagamentoEstornado']);
  });

  it('comando repetido: o pagamento já foi estornado e nada acontece', async () => {
    const { estornar, gateway, publicador } = montar('PAGO', true);

    await estornar.execute(estornarPagamento(), AGORA);
    await estornar.execute(estornarPagamento(), AGORA);

    expect(gateway.chamadas).toEqual(['estornar:1234567890']);
    expect(publicador.tipos()).toEqual(['PagamentoEstornado']);
  });

  it('se a publicação falha depois do estorno, nada é gravado e a nova tentativa estorna de novo', async () => {
    const { estornar, pagamentos, gateway, publicador } = montar('PAGO', true);
    publicador.falhar = true;

    await expect(estornar.execute(estornarPagamento(), AGORA)).rejects.toThrow(
      'SQS fora',
    );
    expect((await pagamentos.buscarPorId('1234567890'))?.status).toBe(
      'APROVADO',
    );

    publicador.falhar = false;
    await estornar.execute(estornarPagamento(), AGORA);

    // O gateway recebe o mesmo estorno duas vezes; a chave de idempotência do
    // adaptador do Mercado Pago faz o segundo não estornar de novo.
    expect(gateway.chamadas).toEqual([
      'estornar:1234567890',
      'estornar:1234567890',
    ]);
    expect((await pagamentos.buscarPorId('1234567890'))?.status).toBe(
      'ESTORNADO',
    );
  });

  it('outro estorno chegou antes: erro, e a nova tentativa não acha pagamento aprovado', async () => {
    const { estornar, pagamentos } = montar('PAGO', true);
    jest.spyOn(pagamentos, 'marcarEstornado').mockResolvedValueOnce(false);

    await expect(estornar.execute(estornarPagamento(), AGORA)).rejects.toThrow(
      'alterado por outra ação',
    );
  });

  it('orçamento mudou no meio do estorno: erro e nada gravado', async () => {
    const { estornar, orcamentos, pagamentos } = montar('PAGO', true);
    jest.spyOn(orcamentos, 'atualizar').mockResolvedValueOnce(false);

    await expect(estornar.execute(estornarPagamento(), AGORA)).rejects.toThrow(
      'alterado por outra ação',
    );
    expect((await pagamentos.buscarPorId('1234567890'))?.status).toBe(
      'APROVADO',
    );
  });

  it('OS sem pagamento aprovado: nada a fazer', async () => {
    const { estornar, gateway } = montar('APROVADO');

    await estornar.execute(estornarPagamento(), AGORA);

    expect(gateway.chamadas).toHaveLength(0);
  });

  it('pagamento sem orçamento é inconsistência: erro para a DLQ', async () => {
    const { estornar, orcamentos } = montar('PAGO', true);
    orcamentos.orcamentos.clear();

    await expect(estornar.execute(estornarPagamento(), AGORA)).rejects.toThrow(
      'não encontrado',
    );
  });
});
