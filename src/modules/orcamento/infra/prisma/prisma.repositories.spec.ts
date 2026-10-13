import type { Prisma } from '../../../../generated/prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import {
  AGORA,
  COBRANCA,
  ORCAMENTO_ID,
  orcamentoDeExemplo,
  OS_ID,
  pagamentoDeExemplo,
} from '../../application/use-case/testes-de-apoio';
import { PrismaOrcamentoRepository } from './prisma-orcamento.repository';
import { PrismaPagamentoRepository } from './prisma-pagamento.repository';
import { PrismaTransacao } from './prisma-transacao';

/**
 * O Prisma é simulado: estes testes conferem o mapeamento entre o domínio e as
 * colunas e os filtros de cada consulta. O SQL de verdade é exercitado no teste
 * de ponta a ponta com o PostgreSQL do docker compose.
 */
function dbFalso() {
  return {
    orcamento: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    pagamento: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
}

/** Linha do orçamento como o Prisma devolve: valores Decimal e ids próprios. */
const decimal = (valor: number) => ({ toString: () => String(valor) });

function orcamentoGravado(sobrescrever: Record<string, unknown> = {}) {
  return {
    id: ORCAMENTO_ID,
    osId: OS_ID,
    codigoOS: 'OS-2026-000001',
    correlationId: 'fluxo-da-os',
    clienteId: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
    clienteNome: 'Maria Silva',
    clienteEmail: 'maria@email.com',
    valorServicos: decimal(120),
    valorPecas: decimal(30.2),
    valorTotal: decimal(150.2),
    status: 'APROVADO',
    origemDecisao: 'CLIENTE',
    motivoRecusa: null,
    motivoCancelamento: null,
    preferenciaId: COBRANCA.preferenciaId,
    linkPagamento: COBRANCA.linkPagamento,
    linkExpiraEm: COBRANCA.expiraEm,
    criadoEm: AGORA,
    atualizadoEm: AGORA,
    decididoEm: AGORA,
    pagoEm: null,
    canceladoEm: null,
    linhas: [
      {
        id: 'l1',
        orcamentoId: ORCAMENTO_ID,
        tipo: 'SERVICO',
        referenciaId: 'srv-1',
        nome: 'Troca de óleo',
        precoUnitario: decimal(120),
        quantidade: 1,
        subtotal: decimal(120),
        posicao: 0,
      },
      {
        id: 'l2',
        orcamentoId: ORCAMENTO_ID,
        tipo: 'ITEM',
        referenciaId: 'item-1',
        nome: 'Filtro de óleo',
        precoUnitario: decimal(15.1),
        quantidade: 2,
        subtotal: decimal(30.2),
        posicao: 1,
      },
    ],
    ...sobrescrever,
  };
}

describe('PrismaOrcamentoRepository', () => {
  let db: ReturnType<typeof dbFalso>;
  let repositorio: PrismaOrcamentoRepository;

  beforeEach(() => {
    db = dbFalso();
    repositorio = new PrismaOrcamentoRepository(
      db as unknown as Prisma.TransactionClient,
    );
  });

  it('grava o orçamento com serviços e itens na tabela de linhas, na ordem', async () => {
    await repositorio.criar(
      orcamentoDeExemplo({
        itens: [
          {
            referenciaId: 'item-1',
            nome: 'Filtro',
            precoUnitario: 15,
            quantidade: 2,
            subtotal: 30,
          },
        ],
      }),
    );

    const [[{ data }]] = db.orcamento.create.mock.calls as [
      [{ data: Record<string, unknown> & { linhas: { create: unknown[] } } }],
    ];
    expect(data).toMatchObject({
      id: ORCAMENTO_ID,
      osId: OS_ID,
      clienteNome: 'Maria Silva',
      status: 'AGUARDANDO_APROVACAO',
    });
    expect(data.linhas.create).toEqual([
      expect.objectContaining({
        tipo: 'SERVICO',
        referenciaId: 'srv-1',
        posicao: 0,
      }),
      expect.objectContaining({
        tipo: 'ITEM',
        referenciaId: 'item-1',
        posicao: 1,
      }),
    ]);
  });

  it('lê o orçamento separando serviços e itens e convertendo os Decimal', async () => {
    db.orcamento.findUnique.mockResolvedValue(orcamentoGravado());

    const orcamento = await repositorio.buscarPorId(ORCAMENTO_ID);

    expect(db.orcamento.findUnique).toHaveBeenCalledWith({
      where: { id: ORCAMENTO_ID },
      include: { linhas: { orderBy: { posicao: 'asc' } } },
    });
    expect(orcamento).toMatchObject({
      cliente: {
        id: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
        nome: 'Maria Silva',
        email: 'maria@email.com',
      },
      servicos: [{ referenciaId: 'srv-1', precoUnitario: 120, subtotal: 120 }],
      itens: [{ referenciaId: 'item-1', precoUnitario: 15.1, subtotal: 30.2 }],
      valorTotal: 150.2,
      cobranca: COBRANCA,
    });
  });

  it('sem preferência gravada, a cobrança é null', async () => {
    db.orcamento.findUnique.mockResolvedValue(
      orcamentoGravado({
        preferenciaId: null,
        linkPagamento: null,
        linkExpiraEm: null,
      }),
    );

    expect((await repositorio.buscarPorOs(OS_ID))?.cobranca).toBeNull();
    expect(db.orcamento.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { osId: OS_ID } }),
    );
  });

  it('busca pelo código da OS e devolve null quando não acha', async () => {
    db.orcamento.findUnique.mockResolvedValue(null);

    expect(await repositorio.buscarPorCodigoOS('OS-2026-000001')).toBeNull();
    expect(db.orcamento.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { codigoOS: 'OS-2026-000001' } }),
    );
  });

  it('atualiza só se o status ainda for o lido, gravando a cobrança em colunas', async () => {
    db.orcamento.updateMany.mockResolvedValue({ count: 1 });

    const gravou = await repositorio.atualizar(
      ORCAMENTO_ID,
      'AGUARDANDO_APROVACAO',
      { status: 'APROVADO', atualizadoEm: AGORA, cobranca: COBRANCA },
    );

    expect(gravou).toBe(true);
    expect(db.orcamento.updateMany).toHaveBeenCalledWith({
      where: { id: ORCAMENTO_ID, status: 'AGUARDANDO_APROVACAO' },
      data: {
        status: 'APROVADO',
        atualizadoEm: AGORA,
        preferenciaId: COBRANCA.preferenciaId,
        linkPagamento: COBRANCA.linkPagamento,
        linkExpiraEm: COBRANCA.expiraEm,
      },
    });
  });

  it('devolve false quando outra ação mudou o status antes', async () => {
    db.orcamento.updateMany.mockResolvedValue({ count: 0 });

    expect(
      await repositorio.atualizar(ORCAMENTO_ID, 'APROVADO', {
        status: 'PAGO',
        atualizadoEm: AGORA,
      }),
    ).toBe(false);
  });
});

describe('PrismaPagamentoRepository', () => {
  let db: ReturnType<typeof dbFalso>;
  let repositorio: PrismaPagamentoRepository;
  const gravado = { ...pagamentoDeExemplo(), valor: decimal(120) };

  beforeEach(() => {
    db = dbFalso();
    repositorio = new PrismaPagamentoRepository(
      db as unknown as Prisma.TransactionClient,
    );
  });

  it('registra o pagamento com o id do Mercado Pago', async () => {
    await repositorio.registrar(pagamentoDeExemplo());

    expect(db.pagamento.create).toHaveBeenCalledWith({
      data: pagamentoDeExemplo(),
    });
  });

  it('busca por id convertendo o valor', async () => {
    db.pagamento.findUnique.mockResolvedValue(gravado);

    expect(await repositorio.buscarPorId('1234567890')).toEqual(
      pagamentoDeExemplo(),
    );
  });

  it('busca por id inexistente devolve null', async () => {
    db.pagamento.findUnique.mockResolvedValue(null);

    expect(await repositorio.buscarPorId('x')).toBeNull();
  });

  it('lista os pagamentos da OS em ordem de registro', async () => {
    db.pagamento.findMany.mockResolvedValue([gravado]);

    expect(await repositorio.listarPorOs(OS_ID)).toHaveLength(1);
    expect(db.pagamento.findMany).toHaveBeenCalledWith({
      where: { osId: OS_ID },
      orderBy: { registradoEm: 'asc' },
    });
  });

  it('busca o pagamento aprovado da OS', async () => {
    db.pagamento.findFirst
      .mockResolvedValueOnce(gravado)
      .mockResolvedValueOnce(null);

    expect((await repositorio.buscarAprovadoDaOs(OS_ID))?.id).toBe(
      '1234567890',
    );
    expect(await repositorio.buscarAprovadoDaOs(OS_ID)).toBeNull();
    expect(db.pagamento.findFirst).toHaveBeenCalledWith({
      where: { osId: OS_ID, status: 'APROVADO' },
    });
  });

  it('marca como estornado só se ainda estiver APROVADO', async () => {
    db.pagamento.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    expect(await repositorio.marcarEstornado('1234567890', AGORA, 'm')).toBe(
      true,
    );
    expect(await repositorio.marcarEstornado('1234567890', AGORA, 'm')).toBe(
      false,
    );
    expect(db.pagamento.updateMany).toHaveBeenCalledWith({
      where: { id: '1234567890', status: 'APROVADO' },
      data: { status: 'ESTORNADO', estornadoEm: AGORA, motivoEstorno: 'm' },
    });
  });
});

describe('PrismaTransacao', () => {
  it('entrega ao trabalho repositórios ligados ao cliente da transação', async () => {
    const tx = dbFalso();
    tx.orcamento.findUnique.mockResolvedValue(null);
    const prisma = {
      $transaction: jest.fn(
        (trabalho: (cliente: unknown) => Promise<unknown>) => trabalho(tx),
      ),
    };

    const resultado = await new PrismaTransacao(
      prisma as unknown as PrismaService,
    ).executar(async ({ orcamentos, pagamentos }) => {
      await orcamentos.buscarPorId(ORCAMENTO_ID);
      await pagamentos.registrar(pagamentoDeExemplo());
      return 'feito';
    });

    expect(resultado).toBe('feito');
    expect(tx.orcamento.findUnique).toHaveBeenCalled();
    expect(tx.pagamento.create).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 15_000,
    });
  });
});
