import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  OrcamentoAlteradoError,
  OrcamentoNaoEncontradoError,
  TransicaoInvalidaError,
} from '../../domain/errors';
import { GatewayPagamentoError } from '../ports/gateway-pagamento';

/**
 * Converte erros de domínio nas exceções HTTP do Nest. Erros desconhecidos são
 * repassados como estão (viram 500 no filtro global).
 */
export function traduzirErroDominio(erro: unknown): unknown {
  if (erro instanceof OrcamentoNaoEncontradoError) {
    return new NotFoundException(erro.message);
  }
  if (
    erro instanceof TransicaoInvalidaError ||
    erro instanceof OrcamentoAlteradoError
  ) {
    return new ConflictException(erro.message);
  }
  if (erro instanceof GatewayPagamentoError) {
    // Nada mudou: o orçamento continua aguardando aprovação e quem chamou pode
    // tentar de novo (docs/contratos.md, rota de aprovação).
    return new ServiceUnavailableException(
      'Mercado Pago indisponível; o orçamento não mudou, tente de novo',
    );
  }
  return erro;
}
