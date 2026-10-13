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
import { traduzirErroDominio } from './traduzir-erro-dominio';

describe('traduzirErroDominio', () => {
  it.each([
    [new OrcamentoNaoEncontradoError('x'), NotFoundException],
    [new TransicaoInvalidaError('RECUSADO', 'aprovar'), ConflictException],
    [new OrcamentoAlteradoError('x'), ConflictException],
    [
      new GatewayPagamentoError('criar o link', 'HTTP 500'),
      ServiceUnavailableException,
    ],
  ])('%s vira %p', (erro, esperado) => {
    expect(traduzirErroDominio(erro)).toBeInstanceOf(esperado);
  });

  it('erro desconhecido passa como está (vira 500 no filtro global)', () => {
    const erro = new Error('banco fora');
    expect(traduzirErroDominio(erro)).toBe(erro);
  });
});
