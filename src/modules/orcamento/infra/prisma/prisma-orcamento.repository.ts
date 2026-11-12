import type { Prisma } from '../../../../generated/prisma/client';
import type {
  LinhaOrcamento,
  Orcamento,
  StatusOrcamento,
} from '../../domain/orcamento';
import type {
  MudancasOrcamento,
  OrcamentoRepository,
} from '../../domain/repository/orcamento.repository';

type LinhaGravada = Prisma.LinhaOrcamentoGetPayload<object>;
type OrcamentoGravado = Prisma.OrcamentoGetPayload<{
  include: { linhas: true };
}>;

const COM_LINHAS = {
  include: { linhas: { orderBy: { posicao: 'asc' } } },
} as const;

/**
 * Orçamentos no PostgreSQL do Billing. Recebe o cliente do Prisma ou o de uma
 * transação (PrismaTransacao), então a mesma classe serve para leitura avulsa e
 * para gravar dentro de uma transação.
 *
 * Serviços e itens ficam na mesma tabela de linhas, separados pelo `tipo` e na
 * ordem em que chegaram (`posicao`).
 */
export class PrismaOrcamentoRepository implements OrcamentoRepository {
  constructor(private readonly db: Prisma.TransactionClient) {}

  async criar(orcamento: Orcamento): Promise<void> {
    const linhas = [
      ...orcamento.servicos.map((l) => ({ ...l, tipo: 'SERVICO' as const })),
      ...orcamento.itens.map((l) => ({ ...l, tipo: 'ITEM' as const })),
    ];

    await this.db.orcamento.create({
      data: {
        id: orcamento.id,
        osId: orcamento.osId,
        codigoOS: orcamento.codigoOS,
        correlationId: orcamento.correlationId,
        clienteId: orcamento.cliente.id,
        clienteNome: orcamento.cliente.nome,
        clienteEmail: orcamento.cliente.email,
        valorServicos: orcamento.valorServicos,
        valorPecas: orcamento.valorPecas,
        valorTotal: orcamento.valorTotal,
        status: orcamento.status,
        criadoEm: orcamento.criadoEm,
        atualizadoEm: orcamento.atualizadoEm,
        linhas: {
          create: linhas.map((linha, posicao) => ({
            tipo: linha.tipo,
            referenciaId: linha.referenciaId,
            nome: linha.nome,
            precoUnitario: linha.precoUnitario,
            quantidade: linha.quantidade,
            subtotal: linha.subtotal,
            posicao,
          })),
        },
      },
    });
  }

  async buscarPorId(id: string): Promise<Orcamento | null> {
    const gravado = await this.db.orcamento.findUnique({
      where: { id },
      ...COM_LINHAS,
    });
    return gravado && paraDominio(gravado);
  }

  async buscarPorOs(osId: string): Promise<Orcamento | null> {
    const gravado = await this.db.orcamento.findUnique({
      where: { osId },
      ...COM_LINHAS,
    });
    return gravado && paraDominio(gravado);
  }

  async buscarPorCodigoOS(codigoOS: string): Promise<Orcamento | null> {
    const gravado = await this.db.orcamento.findUnique({
      where: { codigoOS },
      ...COM_LINHAS,
    });
    return gravado && paraDominio(gravado);
  }

  async atualizar(
    id: string,
    statusAtual: StatusOrcamento,
    mudancas: MudancasOrcamento,
  ): Promise<boolean> {
    const { cobranca, ...campos } = mudancas;
    // updateMany com o status no filtro: a gravação só acontece se ninguém
    // mudou o orçamento desde a leitura (controle de concorrência otimista).
    const { count } = await this.db.orcamento.updateMany({
      where: { id, status: statusAtual },
      data: {
        ...campos,
        ...(cobranca && {
          cobrancaId: cobranca.id,
          qrCode: cobranca.qrCode,
          cobrancaExpiraEm: cobranca.expiraEm,
        }),
      },
    });
    return count === 1;
  }
}

function paraLinha(linha: LinhaGravada): LinhaOrcamento {
  return {
    referenciaId: linha.referenciaId,
    nome: linha.nome,
    precoUnitario: Number(linha.precoUnitario),
    quantidade: linha.quantidade,
    subtotal: Number(linha.subtotal),
  };
}

function paraDominio(gravado: OrcamentoGravado): Orcamento {
  return {
    id: gravado.id,
    osId: gravado.osId,
    codigoOS: gravado.codigoOS,
    correlationId: gravado.correlationId,
    cliente: {
      id: gravado.clienteId,
      nome: gravado.clienteNome,
      email: gravado.clienteEmail,
    },
    servicos: gravado.linhas.filter((l) => l.tipo === 'SERVICO').map(paraLinha),
    itens: gravado.linhas.filter((l) => l.tipo === 'ITEM').map(paraLinha),
    valorServicos: Number(gravado.valorServicos),
    valorPecas: Number(gravado.valorPecas),
    valorTotal: Number(gravado.valorTotal),
    status: gravado.status,
    origemDecisao: gravado.origemDecisao,
    motivoRecusa: gravado.motivoRecusa,
    motivoCancelamento: gravado.motivoCancelamento,
    cobranca:
      gravado.cobrancaId && gravado.qrCode && gravado.cobrancaExpiraEm
        ? {
            id: gravado.cobrancaId,
            qrCode: gravado.qrCode,
            expiraEm: gravado.cobrancaExpiraEm,
          }
        : null,
    criadoEm: gravado.criadoEm,
    atualizadoEm: gravado.atualizadoEm,
    decididoEm: gravado.decididoEm,
    pagoEm: gravado.pagoEm,
    canceladoEm: gravado.canceladoEm,
  };
}
