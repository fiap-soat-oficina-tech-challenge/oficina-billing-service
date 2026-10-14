import { EstornoDePagamento } from '../shared/estorno-de-pagamento';
import { ProcessarNotificacaoPagamentoUseCase } from './processar-notificacao-pagamento.use-case';
import {
  AGORA,
  COBRANCA,
  criarCenario,
  ORCAMENTO_ID,
  orcamentoDeExemplo,
  OS_ID,
  pagamentoDeExemplo,
  pagamentoNoGateway,
} from './testes-de-apoio';

describe('ProcessarNotificacaoPagamentoUseCase', () => {
  function montar(
    statusOrcamento: 'APROVADO' | 'CANCELADO' | 'PAGO' = 'APROVADO',
  ) {
    const cenario = criarCenario();
    cenario.orcamentos.orcamentos.set(
      ORCAMENTO_ID,
      orcamentoDeExemplo({ status: statusOrcamento, cobranca: COBRANCA }),
    );
    const estorno = new EstornoDePagamento(
      cenario.gateway,
      cenario.transacao,
      cenario.publicador,
    );
    const useCase = new ProcessarNotificacaoPagamentoUseCase(
      cenario.orcamentos,
      cenario.pagamentos,
      cenario.transacao,
      cenario.publicador,
      cenario.gateway,
      estorno,
    );
    return { ...cenario, useCase };
  }

  it('pagamento aprovado: registra, marca o orçamento como PAGO e responde PagamentoConfirmado', async () => {
    const { useCase, gateway, orcamentos, pagamentos, publicador } = montar();
    gateway.pagamentos.set('1234567890', pagamentoNoGateway());

    await expect(useCase.execute('1234567890', AGORA)).resolves.toBe(
      'PAGAMENTO_CONFIRMADO',
    );

    expect(gateway.chamadas).toEqual(['consultarPagamento:1234567890']);
    expect(await orcamentos.buscarPorId(ORCAMENTO_ID)).toMatchObject({
      status: 'PAGO',
      pagoEm: new Date('2026-10-20T14:30:00.000Z'),
    });
    expect(await pagamentos.buscarPorId('1234567890')).toMatchObject({
      status: 'APROVADO',
      valor: 120,
      detalhe: 'accredited',
      osId: OS_ID,
    });
    expect(publicador.publicadas).toEqual([
      expect.objectContaining({
        tipo: 'PagamentoConfirmado',
        correlationId: 'fluxo-da-os',
        payload: {
          pagamentoId: '1234567890',
          valor: 120,
          pagoEm: '2026-10-20T14:30:00.000Z',
        },
      }),
    ]);
  });

  it('aviso repetido não trata o pagamento de novo', async () => {
    const { useCase, gateway, publicador } = montar();
    gateway.pagamentos.set('1234567890', pagamentoNoGateway());

    await useCase.execute('1234567890', AGORA);
    await expect(useCase.execute('1234567890', AGORA)).resolves.toBe(
      'JA_PROCESSADO',
    );
    expect(publicador.tipos()).toEqual(['PagamentoConfirmado']);
  });

  it('pagamento recusado: registra e responde PagamentoRecusado com o detalhe', async () => {
    const { useCase, gateway, orcamentos, pagamentos, publicador } = montar();
    gateway.pagamentos.set(
      '1234567890',
      pagamentoNoGateway({
        situacao: 'RECUSADO',
        statusOriginal: 'rejected',
        detalhe: 'cc_rejected_other_reason',
        pagoEm: null,
      }),
    );

    await expect(useCase.execute('1234567890', AGORA)).resolves.toBe(
      'PAGAMENTO_RECUSADO',
    );

    expect((await pagamentos.buscarPorId('1234567890'))?.status).toBe(
      'RECUSADO',
    );
    // A recusa não muda o orçamento: o link continua valendo para nova tentativa.
    expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(
      'APROVADO',
    );
    expect(publicador.publicadas[0]).toMatchObject({
      tipo: 'PagamentoRecusado',
      payload: { detalhe: 'cc_rejected_other_reason' },
    });
  });

  it('depois de uma recusa, o cliente tenta de novo pelo mesmo link e o pagamento é confirmado', async () => {
    const { useCase, gateway, orcamentos, pagamentos, publicador } = montar();
    gateway.pagamentos.set(
      '111',
      pagamentoNoGateway({
        id: '111',
        situacao: 'RECUSADO',
        statusOriginal: 'rejected',
        detalhe: 'cc_rejected_insufficient_amount',
        pagoEm: null,
      }),
    );
    gateway.pagamentos.set('222', pagamentoNoGateway({ id: '222' }));

    await expect(useCase.execute('111', AGORA)).resolves.toBe(
      'PAGAMENTO_RECUSADO',
    );
    await expect(useCase.execute('222', AGORA)).resolves.toBe(
      'PAGAMENTO_CONFIRMADO',
    );

    expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe('PAGO');
    expect(
      (await pagamentos.listarPorOs(OS_ID)).map((p) => [p.id, p.status]),
    ).toEqual([
      ['111', 'RECUSADO'],
      ['222', 'APROVADO'],
    ]);
    expect(publicador.tipos()).toEqual([
      'PagamentoRecusado',
      'PagamentoConfirmado',
    ]);
  });

  it('recusa depois do cancelamento só fica registrada, sem avisar a Saga', async () => {
    const { useCase, gateway, pagamentos, publicador } = montar('CANCELADO');
    gateway.pagamentos.set(
      '1234567890',
      pagamentoNoGateway({ situacao: 'RECUSADO', statusOriginal: 'rejected' }),
    );

    await useCase.execute('1234567890', AGORA);

    expect(await pagamentos.buscarPorId('1234567890')).not.toBeNull();
    expect(publicador.publicadas).toHaveLength(0);
  });

  it.each([
    ['CANCELADO', 'ORCAMENTO_CANCELADO'],
    ['PAGO', 'ORCAMENTO_JA_PAGO'],
  ] as const)(
    'pagamento aprovado com o orçamento %s: estorna e responde PagamentoEstornado',
    async (status, motivo) => {
      const { useCase, gateway, orcamentos, pagamentos, publicador } =
        montar(status);
      gateway.pagamentos.set('1234567890', pagamentoNoGateway());

      await expect(useCase.execute('1234567890', AGORA)).resolves.toBe(
        'PAGAMENTO_ESTORNADO',
      );

      expect(gateway.chamadas).toEqual([
        'consultarPagamento:1234567890',
        'estornar:1234567890',
      ]);
      expect(await pagamentos.buscarPorId('1234567890')).toMatchObject({
        status: 'ESTORNADO',
        motivoEstorno: motivo,
        estornadoEm: new Date('2026-10-20T15:00:00.000Z'),
      });
      expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(status);
      expect(publicador.publicadas[0]).toMatchObject({
        tipo: 'PagamentoEstornado',
        payload: {
          pagamentoId: '1234567890',
          estornadoEm: '2026-10-20T15:00:00.000Z',
        },
      });
    },
  );

  it('cancelamento no meio da confirmação: erro, nada gravado, e o Mercado Pago reenvia', async () => {
    const { useCase, gateway, orcamentos, pagamentos, publicador } = montar();
    gateway.pagamentos.set('1234567890', pagamentoNoGateway());
    jest.spyOn(orcamentos, 'atualizar').mockResolvedValueOnce(false);

    await expect(useCase.execute('1234567890', AGORA)).rejects.toThrow(
      'alterado por outra ação',
    );
    expect(await pagamentos.buscarPorId('1234567890')).toBeNull();
    expect(publicador.publicadas).toHaveLength(0);
  });

  it.each([
    [
      'pendente',
      pagamentoNoGateway({ situacao: 'OUTRA', statusOriginal: 'in_process' }),
    ],
    ['de outro sistema', pagamentoNoGateway({ orcamentoId: 'pedido-123' })],
    ['sem referência', pagamentoNoGateway({ orcamentoId: null })],
    [
      'de orçamento desconhecido',
      pagamentoNoGateway({
        orcamentoId: '00000000-0000-4000-8000-000000000000',
      }),
    ],
  ])('ignora pagamento %s', async (_caso, pagamento) => {
    const { useCase, gateway, pagamentos, publicador } = montar();
    gateway.pagamentos.set('1234567890', pagamento);

    await expect(useCase.execute('1234567890', AGORA)).resolves.toBe(
      'IGNORADO',
    );
    expect(pagamentos.pagamentos.size).toBe(0);
    expect(publicador.publicadas).toHaveLength(0);
  });

  it('ignora pagamento que o Mercado Pago não conhece', async () => {
    const { useCase } = montar();

    await expect(useCase.execute('123456', AGORA)).resolves.toBe('IGNORADO');
  });

  it('erro na consulta ao Mercado Pago volta para quem chamou', async () => {
    const { useCase, gateway } = montar();
    gateway.falha = new Error('timeout');

    await expect(useCase.execute('1234567890', AGORA)).rejects.toThrow(
      'timeout',
    );
  });

  it('não reprocessa pagamento já estornado pelo cancelamento', async () => {
    const { useCase, gateway, pagamentos, publicador } = montar('CANCELADO');
    pagamentos.pagamentos.set(
      '1234567890',
      pagamentoDeExemplo({ status: 'ESTORNADO' }),
    );
    gateway.pagamentos.set('1234567890', pagamentoNoGateway());

    await expect(useCase.execute('1234567890', AGORA)).resolves.toBe(
      'JA_PROCESSADO',
    );
    expect(publicador.publicadas).toHaveLength(0);
  });
});
