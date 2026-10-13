import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ConsumidorSqs } from '../../../../common/mensageria/consumidor-sqs';
import type { Envelope } from '../../../../common/mensageria/envelope';
import { registrarEvento } from '../../../../common/observability';
import { COMANDOS } from '../../application/ports/publicador-respostas';
import { CancelarOrcamentoUseCase } from '../../application/use-case/cancelar-orcamento.use-case';
import { EstornarPagamentoUseCase } from '../../application/use-case/estornar-pagamento.use-case';
import { GerarOrcamentoUseCase } from '../../application/use-case/gerar-orcamento.use-case';

/**
 * Liga a fila `oficina-billing-commands` aos casos de uso, um por tipo de
 * comando. O laço de consumo começa quando a aplicação termina de subir e para
 * no desligamento (SIGTERM do Kubernetes), antes de o processo sair.
 *
 * Tipo desconhecido não pertence a esta fila: é descartado com aviso.
 */
@Injectable()
export class ComandosConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly consumidor: ConsumidorSqs;
  private readonly tratadores: Record<string, (e: Envelope) => Promise<void>>;

  constructor(
    sqs: SQSClient,
    gerarOrcamento: GerarOrcamentoUseCase,
    cancelarOrcamento: CancelarOrcamentoUseCase,
    estornarPagamento: EstornarPagamentoUseCase,
  ) {
    this.tratadores = {
      [COMANDOS.gerarOrcamento]: (e) => gerarOrcamento.execute(e),
      [COMANDOS.cancelarOrcamento]: (e) => cancelarOrcamento.execute(e),
      [COMANDOS.estornarPagamento]: (e) => estornarPagamento.execute(e),
    };
    this.consumidor = new ConsumidorSqs(
      sqs,
      process.env.BILLING_COMMANDS_QUEUE_URL ?? '',
      (envelope) => this.tratar(envelope),
    );
  }

  onApplicationBootstrap(): void {
    void this.consumidor.iniciar();
  }

  onApplicationShutdown(): void {
    this.consumidor.parar();
  }

  private async tratar(envelope: Envelope): Promise<void> {
    const tratador = this.tratadores[envelope.tipo];
    if (!tratador) {
      registrarEvento(
        'billing.comando_desconhecido',
        { tipo_mensagem: envelope.tipo },
        'warn',
      );
      return;
    }
    await tratador(envelope);
  }
}
