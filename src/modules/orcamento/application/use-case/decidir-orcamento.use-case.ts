import { Inject, Injectable } from '@nestjs/common';
import { criarEnvelope } from '../../../../common/mensageria/envelope';
import { registrarEvento } from '../../../../common/observability';
import {
  OrcamentoAlteradoError,
  OrcamentoNaoEncontradoError,
} from '../../domain/errors';
import {
  proximoStatus,
  type Orcamento,
  type OrigemDecisao,
} from '../../domain/orcamento';
import {
  ORCAMENTO_REPOSITORY,
  type MudancasOrcamento,
  type OrcamentoRepository,
} from '../../domain/repository/orcamento.repository';
import { TRANSACAO, type Transacao } from '../../domain/repository/transacao';
import {
  GATEWAY_PAGAMENTO,
  type GatewayPagamento,
} from '../ports/gateway-pagamento';
import { NOTIFICADOR, type Notificador } from '../ports/notificador';
import {
  PUBLICADOR_RESPOSTAS,
  RESPOSTAS,
  type PublicadorRespostas,
} from '../ports/publicador-respostas';
import { traduzirErroDominio } from '../shared/traduzir-erro-dominio';

/** Por quanto tempo o QR Code aceita pagamento. */
export const PRAZO_DA_COBRANCA_EM_HORAS = 72;

export type Decisao =
  { aprovado: true } | { aprovado: false; motivo: string | null };

/**
 * Aprovação ou recusa do orçamento, pelo cliente (rotas com o JWT do CPF) ou
 * pelo sistema externo (webhook com token). As duas origens seguem a mesma
 * regra; só muda o campo `origem` da resposta para a Saga.
 *
 * Aprovar cria a cobrança no Mercado Pago (QR Code dinâmico) **antes** de
 * mudar o orçamento. Se o Mercado Pago falhar, nada muda: o orçamento continua
 * aguardando aprovação, nenhuma mensagem é publicada e a rota responde 503
 * (docs/contratos.md). A cobrança só existe depois da aprovação, e uma nova
 * tentativa de aprovação devolve a mesma cobrança.
 */
@Injectable()
export class DecidirOrcamentoUseCase {
  constructor(
    @Inject(ORCAMENTO_REPOSITORY)
    private readonly orcamentos: OrcamentoRepository,
    @Inject(TRANSACAO)
    private readonly transacao: Transacao,
    @Inject(PUBLICADOR_RESPOSTAS)
    private readonly publicador: PublicadorRespostas,
    @Inject(GATEWAY_PAGAMENTO)
    private readonly gateway: GatewayPagamento,
    @Inject(NOTIFICADOR)
    private readonly notificador: Notificador,
  ) {}

  /** Decisão do cliente dono do orçamento; o orçamento de outro cliente é 404. */
  async peloCliente(
    id: string,
    clienteId: string,
    decisao: Decisao,
    agora: Date = new Date(),
  ): Promise<Orcamento> {
    try {
      const orcamento = await this.orcamentos.buscarPorId(id);
      if (!orcamento || orcamento.cliente.id !== clienteId) {
        throw new OrcamentoNaoEncontradoError(id);
      }
      return await this.decidir(orcamento, decisao, 'CLIENTE', agora);
    } catch (erro) {
      throw traduzirErroDominio(erro);
    }
  }

  /** Decisão do sistema externo, que identifica a OS pelo código. */
  async peloSistemaExterno(
    codigoOS: string,
    decisao: Decisao,
    agora: Date = new Date(),
  ): Promise<Orcamento> {
    try {
      const orcamento = await this.orcamentos.buscarPorCodigoOS(codigoOS);
      if (!orcamento) {
        throw new OrcamentoNaoEncontradoError(`da OS ${codigoOS}`);
      }
      return await this.decidir(orcamento, decisao, 'SISTEMA_EXTERNO', agora);
    } catch (erro) {
      throw traduzirErroDominio(erro);
    }
  }

  private async decidir(
    orcamento: Orcamento,
    decisao: Decisao,
    origem: OrigemDecisao,
    agora: Date,
  ): Promise<Orcamento> {
    const acao = decisao.aprovado ? 'aprovar' : 'recusar';
    const status = proximoStatus(orcamento.status, acao);

    const mudancas: MudancasOrcamento = {
      status,
      atualizadoEm: agora,
      decididoEm: agora,
      origemDecisao: origem,
    };
    let resposta: { tipo: string; payload: Record<string, unknown> };

    if (decisao.aprovado) {
      mudancas.cobranca = await this.gateway.criarCobranca(
        orcamento,
        PRAZO_DA_COBRANCA_EM_HORAS,
        agora,
      );
      resposta = {
        tipo: RESPOSTAS.orcamentoAprovado,
        payload: { orcamentoId: orcamento.id, origem },
      };
    } else {
      mudancas.motivoRecusa = decisao.motivo;
      resposta = {
        tipo: RESPOSTAS.orcamentoRecusado,
        payload: { orcamentoId: orcamento.id, origem, motivo: decisao.motivo },
      };
    }

    await this.transacao.executar(async ({ orcamentos }) => {
      const gravou = await orcamentos.atualizar(
        orcamento.id,
        orcamento.status,
        mudancas,
      );
      if (!gravou) throw new OrcamentoAlteradoError(orcamento.id);
      await this.publicador.publicar(
        criarEnvelope(
          resposta.tipo,
          orcamento.osId,
          orcamento.correlationId,
          resposta.payload,
          agora,
        ),
      );
    });

    const decidido: Orcamento = { ...orcamento, ...mudancas };
    registrarEvento(
      decisao.aprovado ? 'orcamento.aprovado' : 'orcamento.recusado',
      {
        orcamento_id: orcamento.id,
        os_id: orcamento.osId,
        origem,
      },
    );

    if (decisao.aprovado) await this.notificador.enviarCobranca(decidido);
    return decidido;
  }
}
