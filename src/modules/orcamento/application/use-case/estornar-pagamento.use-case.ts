import { Inject, Injectable } from '@nestjs/common';
import type { Envelope } from '../../../../common/mensageria/envelope';
import { registrarEvento } from '../../../../common/observability';
import { OrcamentoNaoEncontradoError } from '../../domain/errors';
import {
  ORCAMENTO_REPOSITORY,
  type OrcamentoRepository,
} from '../../domain/repository/orcamento.repository';
import {
  PAGAMENTO_REPOSITORY,
  type PagamentoRepository,
} from '../../domain/repository/pagamento.repository';
import { EstornoDePagamento } from '../shared/estorno-de-pagamento';
import { lerMotivo } from '../shared/ler-motivo';

/**
 * Consome `EstornarPagamento`, a compensação enviada pelo orquestrador quando o
 * reparo falha depois do pagamento: estorna no Mercado Pago, cancela o
 * orçamento e responde `PagamentoEstornado`.
 *
 * Sem pagamento aprovado para estornar (comando repetido, com o estorno já
 * feito), nada acontece: um pagamento só é estornado uma vez.
 */
@Injectable()
export class EstornarPagamentoUseCase {
  constructor(
    @Inject(ORCAMENTO_REPOSITORY)
    private readonly orcamentos: OrcamentoRepository,
    @Inject(PAGAMENTO_REPOSITORY)
    private readonly pagamentos: PagamentoRepository,
    private readonly estorno: EstornoDePagamento,
  ) {}

  async execute(envelope: Envelope, agora: Date = new Date()): Promise<void> {
    const pagamento = await this.pagamentos.buscarAprovadoDaOs(envelope.osId);
    if (!pagamento) {
      registrarEvento('pagamento.estorno_sem_pagamento_aprovado', {
        os_id: envelope.osId,
      });
      return;
    }

    const orcamento = await this.orcamentos.buscarPorId(pagamento.orcamentoId);
    if (!orcamento) {
      throw new OrcamentoNaoEncontradoError(pagamento.orcamentoId);
    }

    await this.estorno.estornarRegistrado(
      pagamento,
      orcamento,
      lerMotivo(envelope.payload),
      agora,
    );
  }
}
