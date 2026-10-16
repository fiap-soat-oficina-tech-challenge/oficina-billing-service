import { SQSClient } from '@aws-sdk/client-sqs';
import type { Request } from 'express';
import { ConsumidorSqs } from '../../../common/mensageria/consumidor-sqs';
import { criarEnvelope } from '../../../common/mensageria/envelope';
import type { AuthenticatedUser } from '../../auth/domain/types';
import type { CancelarOrcamentoUseCase } from '../application/use-case/cancelar-orcamento.use-case';
import type { ConsultarOrcamentosUseCase } from '../application/use-case/consultar-orcamentos.use-case';
import type { DecidirOrcamentoUseCase } from '../application/use-case/decidir-orcamento.use-case';
import type { EstornarPagamentoUseCase } from '../application/use-case/estornar-pagamento.use-case';
import type { GerarOrcamentoUseCase } from '../application/use-case/gerar-orcamento.use-case';
import type { ProcessarNotificacaoPagamentoUseCase } from '../application/use-case/processar-notificacao-pagamento.use-case';
import {
  COBRANCA,
  CLIENTE_ID,
  ORCAMENTO_ID,
  orcamentoDeExemplo,
  OS_ID,
} from '../application/use-case/testes-de-apoio';
import { ComandosConsumer } from './consumer/comandos.consumer';
import { OrcamentoController } from './controller/orcamento.controller';
import { PagamentoController } from './controller/pagamento.controller';
import {
  lerAvisoMercadoPago,
  WebhookController,
} from './controller/webhook.controller';
import { apresentarOrcamento } from './presenter/orcamento.presenter';

jest.mock('../../../common/mensageria/consumidor-sqs');

const cliente = { id: CLIENTE_ID, tipo: 'cliente' } as AuthenticatedUser;
const req = { user: cliente } as Request & { user: AuthenticatedUser };

describe('apresentarOrcamento', () => {
  it('devolve as linhas com os ids do OS Service e o link no primeiro nível', () => {
    const resposta = apresentarOrcamento(
      orcamentoDeExemplo({
        status: 'APROVADO',
        cobranca: COBRANCA,
        itens: [
          {
            referenciaId: 'item-1',
            nome: 'Filtro',
            precoUnitario: 15,
            quantidade: 1,
            subtotal: 15,
          },
        ],
      }),
    );

    expect(resposta.servicos[0]).toEqual({
      servicoId: 'srv-1',
      nome: 'Troca de óleo',
      precoUnitario: 120,
      quantidade: 1,
      subtotal: 120,
    });
    expect(resposta.itens[0].itemEstoqueId).toBe('item-1');
    expect(resposta.linkPagamento).toBe(COBRANCA.linkPagamento);
    expect(resposta.linkExpiraEm).toEqual(COBRANCA.expiraEm);
    expect(resposta).not.toHaveProperty('cobranca');
  });

  it('antes da aprovação, o link é null', () => {
    expect(apresentarOrcamento(orcamentoDeExemplo())).toMatchObject({
      linkPagamento: null,
      linkExpiraEm: null,
    });
  });
});

describe('OrcamentoController', () => {
  const consultar = {
    listarDaOs: jest.fn().mockResolvedValue([orcamentoDeExemplo()]),
    buscar: jest.fn().mockResolvedValue(orcamentoDeExemplo()),
  };
  const decidir = {
    peloCliente: jest.fn().mockResolvedValue(orcamentoDeExemplo()),
  };
  const controller = new OrcamentoController(
    consultar as unknown as ConsultarOrcamentosUseCase,
    decidir as unknown as DecidirOrcamentoUseCase,
  );

  beforeEach(() => jest.clearAllMocks());

  it('lista e busca com o usuário do token', async () => {
    const lista = await controller.listar({ osId: OS_ID }, req);
    const um = await controller.buscar(ORCAMENTO_ID, req);

    expect(consultar.listarDaOs).toHaveBeenCalledWith(OS_ID, cliente);
    expect(consultar.buscar).toHaveBeenCalledWith(ORCAMENTO_ID, cliente);
    expect(lista[0].id).toBe(ORCAMENTO_ID);
    expect(um.id).toBe(ORCAMENTO_ID);
  });

  it('aprovar e recusar decidem em nome do cliente do token', async () => {
    await controller.aprovar(ORCAMENTO_ID, req);
    await controller.recusar(ORCAMENTO_ID, { motivo: 'Caro' }, req);
    await controller.recusar(ORCAMENTO_ID, {}, req);

    expect(decidir.peloCliente.mock.calls).toEqual([
      [ORCAMENTO_ID, CLIENTE_ID, { aprovado: true }],
      [ORCAMENTO_ID, CLIENTE_ID, { aprovado: false, motivo: 'Caro' }],
      [ORCAMENTO_ID, CLIENTE_ID, { aprovado: false, motivo: null }],
    ]);
  });
});

describe('PagamentoController', () => {
  it('lista os pagamentos da OS', async () => {
    const consultar = { listarPagamentosDaOs: jest.fn().mockResolvedValue([]) };
    const controller = new PagamentoController(
      consultar as unknown as ConsultarOrcamentosUseCase,
    );

    await expect(controller.listar({ osId: OS_ID })).resolves.toEqual([]);
    expect(consultar.listarPagamentosDaOs).toHaveBeenCalledWith(OS_ID);
  });
});

describe('WebhookController', () => {
  const decidir = {
    peloSistemaExterno: jest.fn().mockResolvedValue(orcamentoDeExemplo()),
  };
  const processar = {
    execute: jest.fn().mockResolvedValue('PAGAMENTO_CONFIRMADO'),
  };
  const controller = new WebhookController(
    decidir as unknown as DecidirOrcamentoUseCase,
    processar as unknown as ProcessarNotificacaoPagamentoUseCase,
  );

  beforeEach(() => jest.clearAllMocks());

  it('repassa a decisão do sistema externo', async () => {
    await controller.decidirOrcamento({
      codigoOS: 'OS-2026-000001',
      aprovado: true,
    });
    await controller.decidirOrcamento({
      codigoOS: 'OS-2026-000001',
      aprovado: false,
      motivo: 'Desistiu',
    });
    await controller.decidirOrcamento({
      codigoOS: 'OS-2026-000001',
      aprovado: false,
    });

    expect(decidir.peloSistemaExterno.mock.calls).toEqual([
      ['OS-2026-000001', { aprovado: true }],
      ['OS-2026-000001', { aprovado: false, motivo: 'Desistiu' }],
      ['OS-2026-000001', { aprovado: false, motivo: null }],
    ]);
  });

  it('aviso de pagamento: processa e devolve o resultado', async () => {
    await expect(
      controller.notificacaoMercadoPago(
        {},
        { type: 'payment', data: { id: '123' } },
      ),
    ).resolves.toEqual({ resultado: 'PAGAMENTO_CONFIRMADO' });
    expect(processar.execute).toHaveBeenCalledWith('123');
  });

  it('aviso de outro tópico é ignorado sem consultar o Mercado Pago', async () => {
    await expect(
      controller.notificacaoMercadoPago(
        { topic: 'merchant_order', id: '1' },
        {},
      ),
    ).resolves.toEqual({ resultado: 'IGNORADO' });
    expect(processar.execute).not.toHaveBeenCalled();
  });
});

describe('lerAvisoMercadoPago', () => {
  it.each([
    ['webhook (corpo)', {}, { type: 'payment', data: { id: '123' } }, '123'],
    ['webhook (query)', { type: 'payment', 'data.id': '123' }, {}, '123'],
    ['IPN', { topic: 'payment', id: '123' }, undefined, '123'],
    ['id numérico', {}, { type: 'payment', data: { id: 123 } }, '123'],
    ['outro tópico', {}, { type: 'plan', data: { id: '1' } }, null],
    ['sem id', {}, { type: 'payment', data: {} }, null],
  ])('%s', (_caso, query, corpo, esperado) => {
    expect(
      lerAvisoMercadoPago(
        query as Record<string, unknown>,
        corpo as Record<string, unknown> | undefined,
      ),
    ).toBe(esperado);
  });
});

describe('ComandosConsumer', () => {
  // O consumidor da fila é simulado: o que importa aqui é a ligação entre a
  // fila e os casos de uso, que o ComandosConsumer faz pelo construtor do
  // ConsumidorSqs (fila e função de processamento).
  const ConsumidorSqsSimulado = jest.mocked(ConsumidorSqs);

  beforeEach(() => ConsumidorSqsSimulado.mockClear());

  function montar() {
    process.env.BILLING_COMMANDS_QUEUE_URL =
      'https://fila/oficina-billing-commands';
    const sqs = new SQSClient({ region: 'us-east-1' });
    const gerar = { execute: jest.fn().mockResolvedValue(undefined) };
    const cancelar = { execute: jest.fn().mockResolvedValue(undefined) };
    const estornar = { execute: jest.fn().mockResolvedValue(undefined) };

    const consumer = new ComandosConsumer(
      sqs,
      gerar as unknown as GerarOrcamentoUseCase,
      cancelar as unknown as CancelarOrcamentoUseCase,
      estornar as unknown as EstornarPagamentoUseCase,
    );
    const [cliente, fila, processar] = ConsumidorSqsSimulado.mock.calls[0];
    const consumidor = jest.mocked(ConsumidorSqsSimulado.mock.instances[0]);
    return {
      sqs,
      consumer,
      consumidor,
      cliente,
      fila,
      processar,
      gerar,
      cancelar,
      estornar,
    };
  }

  it('consome a fila de comandos do Billing', () => {
    const { sqs, cliente, fila } = montar();

    expect(cliente).toBe(sqs);
    expect(fila).toBe('https://fila/oficina-billing-commands');
  });

  it('inicia o consumo na subida e para no desligamento', () => {
    const { consumer, consumidor } = montar();

    consumer.onApplicationBootstrap();
    consumer.onApplicationShutdown();

    expect(consumidor.iniciar.mock.calls).toHaveLength(1);
    expect(consumidor.parar.mock.calls).toHaveLength(1);
  });

  it('entrega cada comando ao caso de uso do seu tipo', async () => {
    const { gerar, cancelar, estornar, processar } = montar();
    const envelopes = [
      'GerarOrcamento',
      'CancelarOrcamento',
      'EstornarPagamento',
    ].map((tipo) => criarEnvelope(tipo, OS_ID, 'c', {}));

    for (const envelope of envelopes) await processar(envelope);

    expect(gerar.execute).toHaveBeenCalledWith(envelopes[0]);
    expect(cancelar.execute).toHaveBeenCalledWith(envelopes[1]);
    expect(estornar.execute).toHaveBeenCalledWith(envelopes[2]);
  });

  it('tipo desconhecido é descartado sem erro', async () => {
    const { gerar, processar } = montar();

    await expect(
      processar(criarEnvelope('IniciarReparo', OS_ID, 'c', {})),
    ).resolves.toBeUndefined();
    expect(gerar.execute).not.toHaveBeenCalled();
  });
});
