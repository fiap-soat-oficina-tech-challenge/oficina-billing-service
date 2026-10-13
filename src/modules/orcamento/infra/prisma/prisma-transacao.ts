import type { PrismaService } from '../../../prisma/prisma.service';
import type {
  RepositoriosDaTransacao,
  Transacao,
} from '../../domain/repository/transacao';
import { PrismaOrcamentoRepository } from './prisma-orcamento.repository';
import { PrismaPagamentoRepository } from './prisma-pagamento.repository';

/**
 * Tempo máximo de uma transação. Dentro dela só há gravações no banco e a
 * publicação de uma mensagem no SQS; as chamadas ao Mercado Pago ficam fora,
 * antes da transação, para não segurar conexão do banco esperando a rede.
 */
const TEMPO_MAXIMO_MS = 15_000;

/** Transação interativa do Prisma: commit no fim do trabalho, rollback se ele lançar. */
export class PrismaTransacao implements Transacao {
  constructor(private readonly prisma: PrismaService) {}

  executar<T>(
    trabalho: (repositorios: RepositoriosDaTransacao) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      (tx) =>
        trabalho({
          orcamentos: new PrismaOrcamentoRepository(tx),
          pagamentos: new PrismaPagamentoRepository(tx),
        }),
      { timeout: TEMPO_MAXIMO_MS },
    );
  }
}
