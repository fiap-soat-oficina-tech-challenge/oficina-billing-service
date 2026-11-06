import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { criarEnvelope } from '../../../../common/mensageria/envelope';
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
import { EstornoDePagamento } from '../shared/estorno-de-pagamento';

/** O que foi feito com o aviso; volta na resposta do webhook, para conferência. */
export type ResultadoNotificacao =
  'PAGAMENTO_CONFIRMADO' | 'PAGAMENTO_ESTORNADO' | 'JA_PROCESSADO' | 'IGNORADO';

/**
 * Trata o aviso do Mercado Pago sobre a cobrança (webhook, tópico `order`).
 *
 * O aviso só diz "a order X mudou". O conteúdo nunca é usado: a order é
 * consultada no Mercado Pago (`GET /v1/orders/{id}`), e é dessa consulta que
 * vêm a situação, o valor e o orçamento (`external_reference`).
 *
 * - Paga, com o orçamento aguardando pagamento: registra, marca o orçamento
 *   como PAGO e responde `PagamentoConfirmado` (a OS vai para execução).
 * - Paga, com o orçamento cancelado ou já pago: estorna e responde
 *   `PagamentoEstornado` — nenhuma OS cancelada fica com dinheiro retido.
 * - Cancelada, expirada ou estornada: nada a fazer. São consequências do que
 *   este serviço mesmo pediu, ou do prazo do QR Code.
 *
 * Uma tentativa recusada não gera aviso: a order continua aberta e o cliente
 * paga de novo pelo mesmo QR Code. A OS só avança com um pagamento aprovado.
 *
 * O Mercado Pago repete avisos: um pagamento já registrado não é tratado de
 * novo. Se algo falhar, o erro volta para o Mercado Pago, que reenvia o aviso.
 */
@Injectable()
export class ProcessarNotificacaoPagamentoUseCase {
  constructor(
    @Inject(ORCAMENTO_REPOSITORY)
    private readonly orcamentos: OrcamentoRepository,
    @Inject(PAGAMENTO_REPOSITORY)
    private readonly pagamentos: PagamentoRepository,
    @Inject(TRANSACAO)
    private readonly transacao: Transacao,
    @Inject(PUBLICADOR_RESPOSTAS)
    private readonly publicador: PublicadorRespostas,
    @Inject(GATEWAY_PAGAMENTO)
    private readonly gateway: GatewayPagamento,
    private readonly estorno: EstornoDePagamento,
  ) {}

  async execute(
    cobrancaId: string,
    agora: Date = new Date(),
  ): Promise<ResultadoNotificacao> {
    const pagamento = await this.gateway.consultarPagamento(cobrancaId);
    if (!pagamento) {
      // Id que o Mercado Pago não conhece (por exemplo, o aviso simulado do
      // painel). Responder com erro faria o aviso ser repetido à toa.
      registrarEvento('pagamento.aviso_ignorado', {
        pagamento_id: cobrancaId,
        razao: 'cobranca_inexistente',
      });
      return 'IGNORADO';
    }

    if (pagamento.situacao === 'OUTRA') {
      return this.ignorar(pagamento, 'situacao_sem_efeito');
    }

    // external_reference é o id do orçamento; outro valor não é deste serviço.
    const orcamento =
      pagamento.orcamentoId && isUUID(pagamento.orcamentoId)
        ? await this.orcamentos.buscarPorId(pagamento.orcamentoId)
        : null;
    if (!orcamento) return this.ignorar(pagamento, 'orcamento_desconhecido');

    if (await this.pagamentos.buscarPorId(pagamento.id)) {
      registrarEvento('pagamento.aviso_repetido', {
        pagamento_id: pagamento.id,
      });
      return 'JA_PROCESSADO';
    }

    if (orcamento.status === 'APROVADO') {
      await this.confirmar(pagamento, orcamento, agora);
      return 'PAGAMENTO_CONFIRMADO';
    }

    await this.estorno.estornarNaoAplicado(
      pagamento,
      orcamento,
      motivoDoEstornoAutomatico(orcamento),
      agora,
    );
    return 'PAGAMENTO_ESTORNADO';
  }

  private async confirmar(
    pagamento: PagamentoNoGateway,
    orcamento: Orcamento,
    agora: Date,
  ): Promise<void> {
    const pagoEm = pagamento.pagoEm ?? agora;

    await this.transacao.executar(async ({ orcamentos, pagamentos }) => {
      await pagamentos.registrar({
        id: pagamento.id,
        orcamentoId: orcamento.id,
        osId: orcamento.osId,
        status: 'APROVADO',
        valor: pagamento.valor,
        detalhe: pagamento.detalhe,
        registradoEm: agora,
        pagoEm,
        estornadoEm: null,
        motivoEstorno: null,
      });

      const gravou = await orcamentos.atualizar(orcamento.id, 'APROVADO', {
        status: proximoStatus('APROVADO', 'pagar'),
        atualizadoEm: agora,
        pagoEm,
      });
      // Um cancelamento chegou antes: o erro faz o Mercado Pago reenviar o
      // aviso, e na próxima vez o pagamento cai no estorno.
      if (!gravou) throw new OrcamentoAlteradoError(orcamento.id);

      await this.publicador.publicar(
        criarEnvelope(
          RESPOSTAS.pagamentoConfirmado,
          orcamento.osId,
          orcamento.correlationId,
          {
            pagamentoId: pagamento.id,
            valor: pagamento.valor,
            pagoEm: pagoEm.toISOString(),
          },
          agora,
        ),
      );
    });

    registrarEvento('pagamento.confirmado', {
      pagamento_id: pagamento.id,
      orcamento_id: orcamento.id,
      os_id: orcamento.osId,
      valor: pagamento.valor,
    });
  }

  private ignorar(
    pagamento: PagamentoNoGateway,
    razao: string,
  ): ResultadoNotificacao {
    registrarEvento('pagamento.aviso_ignorado', {
      pagamento_id: pagamento.id,
      status_gateway: pagamento.statusOriginal,
      razao,
    });
    return 'IGNORADO';
  }
}

function motivoDoEstornoAutomatico(orcamento: Orcamento): string {
  if (orcamento.status === 'CANCELADO') return 'ORCAMENTO_CANCELADO';
  if (orcamento.status === 'PAGO') return 'ORCAMENTO_JA_PAGO';
  return 'ORCAMENTO_NAO_APROVADO';
}
