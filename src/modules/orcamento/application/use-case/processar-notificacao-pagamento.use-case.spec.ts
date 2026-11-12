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

const ID = COBRANCA.id;

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
    gateway.pagamentos.set(ID, pagamentoNoGateway());

    await expect(useCase.execute(ID, AGORA)).resolves.toBe(
      'PAGAMENTO_CONFIRMADO',
    );

    expect(gateway.chamadas).toEqual([`consultarPagamento:${ID}`]);
    expect(await orcamentos.buscarPorId(ORCAMENTO_ID)).toMatchObject({
      status: 'PAGO',
      pagoEm: new Date('2026-10-20T14:30:00.000Z'),
    });
    expect(await pagamentos.buscarPorId(ID)).toMatchObject({
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
          pagamentoId: ID,
          valor: 120,
          pagoEm: '2026-10-20T14:30:00.000Z',
        },
      }),
    ]);
  });

  it('aviso repetido não trata o pagamento de novo', async () => {
    const { useCase, gateway, publicador } = montar();
    gateway.pagamentos.set(ID, pagamentoNoGateway());

    await useCase.execute(ID, AGORA);
    await expect(useCase.execute(ID, AGORA)).resolves.toBe('JA_PROCESSADO');
    expect(publicador.tipos()).toEqual(['PagamentoConfirmado']);
  });

  it('order aberta, inclusive depois de uma recusa: nada muda, e o pagamento pelo mesmo QR Code é confirmado', async () => {
    const { useCase, gateway, orcamentos, pagamentos, publicador } = montar();
    gateway.pagamentos.set(
      ID,
      pagamentoNoGateway({
        situacao: 'OUTRA',
        statusOriginal: 'created',
        detalhe: 'created',
        pagoEm: null,
      }),
    );

    await expect(useCase.execute(ID, AGORA)).resolves.toBe('IGNORADO');
    expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(
      'APROVADO',
    );

    gateway.pagamentos.set(ID, pagamentoNoGateway());
    await expect(useCase.execute(ID, AGORA)).resolves.toBe(
      'PAGAMENTO_CONFIRMADO',
    );
    expect((await pagamentos.listarPorOs(OS_ID)).map((p) => p.status)).toEqual([
      'APROVADO',
    ]);
    expect(publicador.tipos()).toEqual(['PagamentoConfirmado']);
  });

  it.each(['canceled', 'expired', 'refunded'])(
    'order %s é ignorada: consequência do próprio Billing ou do prazo do QR Code',
    async (status) => {
      const { useCase, gateway, pagamentos, publicador } = montar();
      gateway.pagamentos.set(
        ID,
        pagamentoNoGateway({ situacao: 'OUTRA', statusOriginal: status }),
      );

      await expect(useCase.execute(ID, AGORA)).resolves.toBe('IGNORADO');
      expect(pagamentos.pagamentos.size).toBe(0);
      expect(publicador.publicadas).toHaveLength(0);
    },
  );

  it.each([
    ['CANCELADO', 'ORCAMENTO_CANCELADO'],
    ['PAGO', 'ORCAMENTO_JA_PAGO'],
  ] as const)(
    'pagamento aprovado com o orçamento %s: estorna e responde PagamentoEstornado',
    async (status, motivo) => {
      const { useCase, gateway, orcamentos, pagamentos, publicador } =
        montar(status);
      gateway.pagamentos.set(ID, pagamentoNoGateway());

      await expect(useCase.execute(ID, AGORA)).resolves.toBe(
        'PAGAMENTO_ESTORNADO',
      );

      expect(gateway.chamadas).toEqual([
        `consultarPagamento:${ID}`,
        `estornar:${ID}`,
      ]);
      expect(await pagamentos.buscarPorId(ID)).toMatchObject({
        status: 'ESTORNADO',
        motivoEstorno: motivo,
        estornadoEm: new Date('2026-10-20T15:00:00.000Z'),
      });
      expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(status);
      expect(publicador.publicadas[0]).toMatchObject({
        tipo: 'PagamentoEstornado',
        payload: {
          pagamentoId: ID,
          estornadoEm: '2026-10-20T15:00:00.000Z',
        },
      });
    },
  );

  it('cancelamento no meio da confirmação: erro, nada gravado, e o Mercado Pago reenvia', async () => {
    const { useCase, gateway, orcamentos, pagamentos, publicador } = montar();
    gateway.pagamentos.set(ID, pagamentoNoGateway());
    jest.spyOn(orcamentos, 'atualizar').mockResolvedValueOnce(false);

    await expect(useCase.execute(ID, AGORA)).rejects.toThrow(
      'alterado por outra ação',
    );
    expect(await pagamentos.buscarPorId(ID)).toBeNull();
    expect(publicador.publicadas).toHaveLength(0);
  });

  it.each([
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
    gateway.pagamentos.set(ID, pagamento);

    await expect(useCase.execute(ID, AGORA)).resolves.toBe('IGNORADO');
    expect(pagamentos.pagamentos.size).toBe(0);
    expect(publicador.publicadas).toHaveLength(0);
  });

  it('ignora aviso de order que o Mercado Pago não conhece (o simulado do painel)', async () => {
    const { useCase } = montar();

    await expect(useCase.execute('123456', AGORA)).resolves.toBe('IGNORADO');
  });

  it('erro na consulta ao Mercado Pago volta para quem chamou', async () => {
    const { useCase, gateway } = montar();
    gateway.falha = new Error('timeout');

    await expect(useCase.execute(ID, AGORA)).rejects.toThrow('timeout');
  });

  it('não reprocessa pagamento já estornado pelo cancelamento', async () => {
    const { useCase, gateway, pagamentos, publicador } = montar('CANCELADO');
    pagamentos.pagamentos.set(ID, pagamentoDeExemplo({ status: 'ESTORNADO' }));
    gateway.pagamentos.set(ID, pagamentoNoGateway());

    await expect(useCase.execute(ID, AGORA)).resolves.toBe('JA_PROCESSADO');
    expect(publicador.publicadas).toHaveLength(0);
  });
});
