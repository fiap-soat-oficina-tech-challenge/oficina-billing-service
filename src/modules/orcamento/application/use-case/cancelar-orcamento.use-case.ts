import { Inject, Injectable } from '@nestjs/common';
import type { Envelope } from '../../../../common/mensageria/envelope';
import { registrarEvento } from '../../../../common/observability';
import { OrcamentoAlteradoError } from '../../domain/errors';
import { proximoStatus, type Orcamento } from '../../domain/orcamento';
import {
  ORCAMENTO_REPOSITORY,
  type OrcamentoRepository,
} from '../../domain/repository/orcamento.repository';
import {
  PAGAMENTO_REPOSITORY,
  type PagamentoRepository,
} from '../../domain/repository/pagamento.repository';
import {
  GATEWAY_PAGAMENTO,
  type GatewayPagamento,
} from '../ports/gateway-pagamento';
import { EstornoDePagamento } from '../shared/estorno-de-pagamento';
import { lerMotivo } from '../shared/ler-motivo';

/**
 * Consome `CancelarOrcamento`, a compensação enviada pelo orquestrador quando o
 * funcionário cancela uma OS que espera o cliente (aprovação ou pagamento): o
 * cliente desistiu, o QR Code expirou ou os pagamentos foram recusados e ele
 * não tentou de novo. O que fazer depende de onde o orçamento parou:
 *
 * | Status do orçamento      | O que acontece                                      |
 * |--------------------------|-----------------------------------------------------|
 * | `AGUARDANDO_APROVACAO`   | cancela                                             |
 * | `APROVADO` (tem QR Code) | cancela a cobrança no Mercado Pago e o orçamento    |
 * | `PAGO`                   | estorna, cancela e responde `PagamentoEstornado`    |
 * | `RECUSADO` / `CANCELADO` | nada: já está encerrado (comando repetido)          |
 *
 * A cobrança é cancelada porque o QR Code aceita pagamento até expirar,
 * inclusive depois de uma recusa. Se o cliente pagou no meio do cancelamento, o
 * Mercado Pago não cancela a cobrança paga: o orçamento é cancelado mesmo assim
 * e o aviso do pagamento cai no estorno automático. Se o Mercado Pago falhar, a
 * mensagem volta para a fila e o cancelamento é repetido; depois de 5
 * tentativas vai para a DLQ, então a compensação nunca se perde.
 */
@Injectable()
export class CancelarOrcamentoUseCase {
  constructor(
    @Inject(ORCAMENTO_REPOSITORY)
    private readonly orcamentos: OrcamentoRepository,
    @Inject(PAGAMENTO_REPOSITORY)
    private readonly pagamentos: PagamentoRepository,
    @Inject(GATEWAY_PAGAMENTO)
    private readonly gateway: GatewayPagamento,
    private readonly estorno: EstornoDePagamento,
  ) {}

  async execute(envelope: Envelope, agora: Date = new Date()): Promise<void> {
    const motivo = lerMotivo(envelope.payload);
    const orcamento = await this.orcamentos.buscarPorOs(envelope.osId);

    if (!orcamento) {
      registrarEvento(
        'orcamento.cancelamento_sem_orcamento',
        { os_id: envelope.osId },
        'warn',
      );
      return;
    }

    switch (orcamento.status) {
      case 'RECUSADO':
      case 'CANCELADO':
        registrarEvento('orcamento.cancelamento_repetido', {
          orcamento_id: orcamento.id,
          status: orcamento.status,
        });
        return;

      case 'PAGO':
        return this.estornarECancelar(orcamento, motivo, agora);

      case 'APROVADO':
        if (orcamento.cobranca) {
          await this.gateway.cancelarCobranca(orcamento.cobranca.id);
        }
        return this.cancelar(orcamento, motivo, agora);

      case 'AGUARDANDO_APROVACAO':
        return this.cancelar(orcamento, motivo, agora);
    }
  }

  private async cancelar(
    orcamento: Orcamento,
    motivo: string,
    agora: Date,
  ): Promise<void> {
    const gravou = await this.orcamentos.atualizar(
      orcamento.id,
      orcamento.status,
      {
        status: proximoStatus(orcamento.status, 'cancelar'),
        atualizadoEm: agora,
        motivoCancelamento: motivo,
        canceladoEm: agora,
      },
    );
    // Um pagamento chegou no meio: a mensagem volta para a fila e, na próxima
    // tentativa, o orçamento já está PAGO e cai no estorno.
    if (!gravou) throw new OrcamentoAlteradoError(orcamento.id);

    registrarEvento('orcamento.cancelado', {
      orcamento_id: orcamento.id,
      os_id: orcamento.osId,
      status_anterior: orcamento.status,
      motivo,
    });
  }

  /** O cliente pagou enquanto a OS era cancelada: o dinheiro volta. */
  private async estornarECancelar(
    orcamento: Orcamento,
    motivo: string,
    agora: Date,
  ): Promise<void> {
    const pagamento = await this.pagamentos.buscarAprovadoDaOs(orcamento.osId);
    if (!pagamento) {
      // PAGO e o pagamento aprovado são gravados juntos; sem ele, o dado está
      // inconsistente. A mensagem vai para a DLQ para análise.
      throw new Error(
        `Orçamento ${orcamento.id} está PAGO sem pagamento aprovado`,
      );
    }
    await this.estorno.estornarRegistrado(pagamento, orcamento, motivo, agora);
  }
}
