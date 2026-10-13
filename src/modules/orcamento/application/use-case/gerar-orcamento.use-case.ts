import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  criarEnvelope,
  type Envelope,
} from '../../../../common/mensageria/envelope';
import { registrarEvento } from '../../../../common/observability';
import type { Orcamento } from '../../domain/orcamento';
import {
  ORCAMENTO_REPOSITORY,
  type OrcamentoRepository,
} from '../../domain/repository/orcamento.repository';
import { TRANSACAO, type Transacao } from '../../domain/repository/transacao';
import { NOTIFICADOR, type Notificador } from '../ports/notificador';
import {
  PUBLICADOR_RESPOSTAS,
  RESPOSTAS,
  type PublicadorRespostas,
} from '../ports/publicador-respostas';
import { lerComandoGerarOrcamento } from '../shared/ler-comando-gerar-orcamento';

/**
 * Consome `GerarOrcamento`: cria o orçamento da OS, responde `OrcamentoEnviado`
 * e manda o orçamento ao cliente por e-mail.
 *
 * - Comando repetido (o SQS entrega pelo menos uma vez): a OS já tem orçamento,
 *   e a mensagem é dada como processada sem publicar de novo. Como o orçamento
 *   e a resposta são gravados e publicados na mesma transação, orçamento
 *   gravado implica resposta publicada.
 * - Comando inválido ou sem nenhuma linha é falha de negócio: responde
 *   `GeracaoOrcamentoFalhou` para o orquestrador compensar, em vez de deixar a
 *   mensagem cair na DLQ.
 */
@Injectable()
export class GerarOrcamentoUseCase {
  constructor(
    @Inject(ORCAMENTO_REPOSITORY)
    private readonly orcamentos: OrcamentoRepository,
    @Inject(TRANSACAO)
    private readonly transacao: Transacao,
    @Inject(PUBLICADOR_RESPOSTAS)
    private readonly publicador: PublicadorRespostas,
    @Inject(NOTIFICADOR)
    private readonly notificador: Notificador,
  ) {}

  async execute(envelope: Envelope, agora: Date = new Date()): Promise<void> {
    const { osId, correlationId } = envelope;

    const dados = lerComandoGerarOrcamento(envelope.payload);
    if ('motivo' in dados) {
      await this.publicador.publicar(
        criarEnvelope(
          RESPOSTAS.geracaoOrcamentoFalhou,
          osId,
          correlationId,
          { motivo: dados.motivo },
          agora,
        ),
      );
      registrarEvento(
        'orcamento.comando_invalido',
        { motivo: dados.motivo },
        'warn',
      );
      return;
    }

    if (await this.orcamentos.buscarPorOs(osId)) {
      registrarEvento('orcamento.comando_repetido', { os_id: osId });
      return;
    }

    const orcamento: Orcamento = {
      id: randomUUID(),
      osId,
      codigoOS: dados.codigo,
      correlationId,
      cliente: dados.cliente,
      servicos: dados.servicos,
      itens: dados.itens,
      valorServicos: dados.valorServicos,
      valorPecas: dados.valorPecas,
      valorTotal: dados.valorTotal,
      status: 'AGUARDANDO_APROVACAO',
      origemDecisao: null,
      motivoRecusa: null,
      motivoCancelamento: null,
      cobranca: null,
      criadoEm: agora,
      atualizadoEm: agora,
      decididoEm: null,
      pagoEm: null,
      canceladoEm: null,
    };

    await this.transacao.executar(async ({ orcamentos }) => {
      await orcamentos.criar(orcamento);
      await this.publicador.publicar(
        criarEnvelope(
          RESPOSTAS.orcamentoEnviado,
          osId,
          correlationId,
          { orcamentoId: orcamento.id, valorTotal: orcamento.valorTotal },
          agora,
        ),
      );
    });

    registrarEvento('orcamento.gerado', {
      orcamento_id: orcamento.id,
      os_id: osId,
      valor_total: orcamento.valorTotal,
    });

    await this.notificador.enviarOrcamento(orcamento);
  }
}
