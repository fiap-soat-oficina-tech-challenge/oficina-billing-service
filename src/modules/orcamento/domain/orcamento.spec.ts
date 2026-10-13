import { emCentavos, iguais, multiplicar, somar } from './dinheiro';
import { TransicaoInvalidaError } from './errors';
import {
  proximoStatus,
  type AcaoOrcamento,
  type StatusOrcamento,
} from './orcamento';

describe('ciclo do orçamento', () => {
  it.each<[StatusOrcamento, AcaoOrcamento, StatusOrcamento]>([
    ['AGUARDANDO_APROVACAO', 'aprovar', 'APROVADO'],
    ['AGUARDANDO_APROVACAO', 'recusar', 'RECUSADO'],
    ['APROVADO', 'pagar', 'PAGO'],
    ['AGUARDANDO_APROVACAO', 'cancelar', 'CANCELADO'],
    ['APROVADO', 'cancelar', 'CANCELADO'],
    ['PAGO', 'cancelar', 'CANCELADO'],
  ])('%s --%s--> %s', (atual, acao, esperado) => {
    expect(proximoStatus(atual, acao)).toBe(esperado);
  });

  it.each<[StatusOrcamento, AcaoOrcamento]>([
    ['APROVADO', 'aprovar'],
    ['APROVADO', 'recusar'],
    ['AGUARDANDO_APROVACAO', 'pagar'],
    ['PAGO', 'pagar'],
    ['RECUSADO', 'cancelar'],
    ['CANCELADO', 'cancelar'],
    ['CANCELADO', 'pagar'],
  ])('recusa %s --%s-->', (atual, acao) => {
    expect(() => proximoStatus(atual, acao)).toThrow(TransicaoInvalidaError);
  });
});

describe('dinheiro', () => {
  it('soma sem erro de ponto flutuante', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(somar([0.1, 0.2])).toBe(0.3);
    expect(somar([120, 30.2])).toBe(150.2);
  });

  it('multiplica o preço pela quantidade em centavos', () => {
    expect(multiplicar(15.1, 3)).toBe(45.3);
  });

  it('compara valores pelos centavos', () => {
    expect(iguais(150.2, 150.20000000000002)).toBe(true);
    expect(iguais(150.2, 150.21)).toBe(false);
    expect(emCentavos(19.99)).toBe(1999);
  });
});
