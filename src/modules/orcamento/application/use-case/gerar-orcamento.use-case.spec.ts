import { GerarOrcamentoUseCase } from './gerar-orcamento.use-case';
import {
  AGORA,
  criarCenario,
  envelopeDeComando,
  OS_ID,
  payloadGerarOrcamento,
} from './testes-de-apoio';

describe('GerarOrcamentoUseCase', () => {
  function montar() {
    const cenario = criarCenario();
    const useCase = new GerarOrcamentoUseCase(
      cenario.orcamentos,
      cenario.transacao,
      cenario.publicador,
      cenario.notificador,
    );
    return { ...cenario, useCase };
  }

  it('cria o orçamento, responde OrcamentoEnviado e envia o e-mail', async () => {
    const { useCase, orcamentos, publicador, notificador } = montar();
    const comando = envelopeDeComando(
      'GerarOrcamento',
      payloadGerarOrcamento(),
    );

    await useCase.execute(comando, AGORA);

    const orcamento = await orcamentos.buscarPorOs(OS_ID);
    expect(orcamento).toMatchObject({
      osId: OS_ID,
      codigoOS: 'OS-2026-000001',
      correlationId: 'fluxo-da-os',
      status: 'AGUARDANDO_APROVACAO',
      valorTotal: 150.2,
      criadoEm: AGORA,
    });
    expect(orcamento?.servicos).toHaveLength(1);
    expect(orcamento?.itens).toHaveLength(1);

    expect(publicador.publicadas).toEqual([
      expect.objectContaining({
        tipo: 'OrcamentoEnviado',
        osId: OS_ID,
        correlationId: 'fluxo-da-os',
        payload: { orcamentoId: orcamento?.id, valorTotal: 150.2 },
      }),
    ]);
    expect(notificador.enviados).toEqual([`orcamento:${orcamento?.id}`]);
  });

  it('comando repetido não cria outro orçamento nem publica de novo', async () => {
    const { useCase, orcamentos, publicador, notificador } = montar();
    const comando = envelopeDeComando(
      'GerarOrcamento',
      payloadGerarOrcamento(),
    );

    await useCase.execute(comando, AGORA);
    await useCase.execute(comando, AGORA);

    expect(orcamentos.orcamentos.size).toBe(1);
    expect(publicador.tipos()).toEqual(['OrcamentoEnviado']);
    expect(notificador.enviados).toHaveLength(1);
  });

  it('OS sem linhas responde GeracaoOrcamentoFalhou com ORCAMENTO_VAZIO', async () => {
    const { useCase, orcamentos, publicador, notificador } = montar();
    const comando = envelopeDeComando('GerarOrcamento', {
      ...payloadGerarOrcamento(),
      servicos: [],
      itens: [],
      valorServicos: 0,
      valorPecas: 0,
      valorTotal: 0,
    });

    await useCase.execute(comando, AGORA);

    expect(orcamentos.orcamentos.size).toBe(0);
    expect(publicador.publicadas).toEqual([
      expect.objectContaining({
        tipo: 'GeracaoOrcamentoFalhou',
        correlationId: 'fluxo-da-os',
        payload: { motivo: 'ORCAMENTO_VAZIO' },
      }),
    ]);
    expect(notificador.enviados).toHaveLength(0);
  });

  it('comando inválido responde GeracaoOrcamentoFalhou com o problema', async () => {
    const { useCase, publicador } = montar();

    await useCase.execute(
      envelopeDeComando('GerarOrcamento', { codigo: 'OS-2026-000001' }),
      AGORA,
    );

    expect(publicador.publicadas[0]).toMatchObject({
      tipo: 'GeracaoOrcamentoFalhou',
      payload: { motivo: 'COMANDO_INVALIDO: cliente precisa de id e nome' },
    });
  });

  it('se a publicação falha, nada é gravado e o erro devolve a mensagem para a fila', async () => {
    const { useCase, orcamentos, publicador, notificador } = montar();
    publicador.falhar = true;

    await expect(
      useCase.execute(
        envelopeDeComando('GerarOrcamento', payloadGerarOrcamento()),
        AGORA,
      ),
    ).rejects.toThrow('SQS fora');

    expect(orcamentos.orcamentos.size).toBe(0);
    expect(notificador.enviados).toHaveLength(0);
  });
});
