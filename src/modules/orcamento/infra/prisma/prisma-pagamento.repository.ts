import type { Prisma } from '../../../../generated/prisma/client';
import type { Pagamento } from '../../domain/pagamento';
import type { PagamentoRepository } from '../../domain/repository/pagamento.repository';

type PagamentoGravado = Prisma.PagamentoGetPayload<object>;

/** Pagamentos no PostgreSQL do Billing; mesma ideia de PrismaOrcamentoRepository. */
export class PrismaPagamentoRepository implements PagamentoRepository {
  constructor(private readonly db: Prisma.TransactionClient) {}

  async registrar(pagamento: Pagamento): Promise<void> {
    await this.db.pagamento.create({ data: pagamento });
  }

  async buscarPorId(id: string): Promise<Pagamento | null> {
    const gravado = await this.db.pagamento.findUnique({ where: { id } });
    return gravado && paraDominio(gravado);
  }

  async listarPorOs(osId: string): Promise<Pagamento[]> {
    const gravados = await this.db.pagamento.findMany({
      where: { osId },
      orderBy: { registradoEm: 'asc' },
    });
    return gravados.map(paraDominio);
  }

  async buscarAprovadoDaOs(osId: string): Promise<Pagamento | null> {
    const gravado = await this.db.pagamento.findFirst({
      where: { osId, status: 'APROVADO' },
    });
    return gravado && paraDominio(gravado);
  }

  async marcarEstornado(
    id: string,
    estornadoEm: Date,
    motivoEstorno: string,
  ): Promise<boolean> {
    const { count } = await this.db.pagamento.updateMany({
      where: { id, status: 'APROVADO' },
      data: { status: 'ESTORNADO', estornadoEm, motivoEstorno },
    });
    return count === 1;
  }
}

function paraDominio(gravado: PagamentoGravado): Pagamento {
  return { ...gravado, valor: Number(gravado.valor) };
}
