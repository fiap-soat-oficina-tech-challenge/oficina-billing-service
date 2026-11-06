import { Inject, Injectable } from '@nestjs/common';
import { criarEnvelope } from '../../../../common/mensageria/envelope';
import { registrarEvento } from '../../../../common/observability';
import {
  OrcamentoAlteradoError,
  PagamentoAlteradoError,
} from '../../domain/errors';
import { proximoStatus, type Orcamento } from '../../domain/orcamento';
import type { Pagamento } from '../../domain/pagamento';
import { TRANSACAO, type Transacao } from '../../domain/repository/transacao';
import {
  GATEWAY_PAGAMENTO,
  type GatewayPagamento,
  type PagamentoNoGateway,
} from '../ports/gateway-pagamento';
import {
  PUBLICADOR_RESPOSTAS,
  RESPOSTAS,
  type PublicadorRespostas,
} from '../ports/publicador-respostas';

/**
 * Estorno de pagamento, usado em três situações (docs/contratos.md):
 *
 * 1. `EstornarPagamento` — o reparo falhou e a OS foi cancelada com o
 *    pagamento já feito;
 * 2. `CancelarOrcamento` com o orçamento já pago — o cliente pagou enquanto a
 *    OS era cancelada;
 * 3. um pagamento aprovado que chega depois do cancelamento (o cliente pagou o
 *    QR Code enquanto a OS era cancelada).
 *
 * Em todas, nenhuma OS cancelada fica com dinheiro retido, e o orquestrador
 * recebe `PagamentoEstornado`.
 *
 * O estorno no Mercado Pago vem primeiro e só depois a gravação com a
 * publicação, na mesma transação. Se a gravação falhar, a mensagem (ou o aviso
 * do Mercado Pago) é processada de novo e o estorno é repetido — o gateway não
 * estorna duas vezes a mesma cobrança.
 */
@Injectable()
export class EstornoDePagamento {
  constructor(
    @Inject(GATEWAY_PAGAMENTO)
    private readonly gateway: GatewayPagamento,
    @Inject(TRANSACAO)
    private readonly transacao: Transacao,
    @Inject(PUBLICADOR_RESPOSTAS)
    private readonly publicador: PublicadorRespostas,
  ) {}

  /**
   * Estorna um pagamento já registrado como APROVADO (situações 1 e 2) e
   * cancela o orçamento pago.
   */
  async estornarRegistrado(
    pagamento: Pagamento,
    orcamento: Orcamento,
    motivo: string,
    agora: Date = new Date(),
  ): Promise<void> {
    const { estornadoEm } = await this.gateway.estornar(pagamento.id);

    await this.transacao.executar(async ({ orcamentos, pagamentos }) => {
      const marcou = await pagamentos.marcarEstornado(
        pagamento.id,
        estornadoEm,
        motivo,
      );
      if (!marcou) throw new PagamentoAlteradoError(pagamento.id);

      if (orcamento.status === 'PAGO') {
        const cancelou = await orcamentos.atualizar(orcamento.id, 'PAGO', {
          status: proximoStatus('PAGO', 'cancelar'),
          atualizadoEm: agora,
          motivoCancelamento: motivo,
          canceladoEm: agora,
        });
        if (!cancelou) throw new OrcamentoAlteradoError(orcamento.id);
      }

      await this.publicarEstorno(orcamento, pagamento.id, estornadoEm, agora);
    });

    this.registrar(orcamento, pagamento.id, motivo);
  }

  /**
   * Estorna um pagamento aprovado que não pode ser aplicado ao orçamento
   * (situação 3) e o registra já como ESTORNADO. O orçamento não muda.
   */
  async estornarNaoAplicado(
    pagamento: PagamentoNoGateway,
    orcamento: Orcamento,
    motivo: string,
    agora: Date = new Date(),
  ): Promise<void> {
    const { estornadoEm } = await this.gateway.estornar(pagamento.id);

    await this.transacao.executar(async ({ pagamentos }) => {
      await pagamentos.registrar({
        id: pagamento.id,
        orcamentoId: orcamento.id,
        osId: orcamento.osId,
        status: 'ESTORNADO',
        valor: pagamento.valor,
        detalhe: pagamento.detalhe,
        registradoEm: agora,
        pagoEm: pagamento.pagoEm,
        estornadoEm,
        motivoEstorno: motivo,
      });
      await this.publicarEstorno(orcamento, pagamento.id, estornadoEm, agora);
    });

    this.registrar(orcamento, pagamento.id, motivo);
  }

  private publicarEstorno(
    orcamento: Orcamento,
    pagamentoId: string,
    estornadoEm: Date,
    agora: Date,
  ): Promise<void> {
    return this.publicador.publicar(
      criarEnvelope(
        RESPOSTAS.pagamentoEstornado,
        orcamento.osId,
        orcamento.correlationId,
        { pagamentoId, estornadoEm: estornadoEm.toISOString() },
        agora,
      ),
    );
  }

  private registrar(
    orcamento: Orcamento,
    pagamentoId: string,
    motivo: string,
  ): void {
    registrarEvento('pagamento.estornado', {
      pagamento_id: pagamentoId,
      orcamento_id: orcamento.id,
      os_id: orcamento.osId,
      motivo,
    });
  }
}
