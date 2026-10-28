import { NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../auth/domain/types';
import { ConsultarOrcamentosUseCase } from './consultar-orcamentos.use-case';
import {
  CLIENTE_ID,
  criarCenario,
  ORCAMENTO_ID,
  orcamentoDeExemplo,
  OS_ID,
  pagamentoDeExemplo,
} from './testes-de-apoio';

describe('ConsultarOrcamentosUseCase', () => {
  const funcionario: AuthenticatedUser = { id: 'u1', tipo: 'admin' };
  const dono: AuthenticatedUser = { id: CLIENTE_ID, tipo: 'cliente' };
  const outroCliente: AuthenticatedUser = { id: 'c2', tipo: 'cliente' };

  function montar() {
    const cenario = criarCenario();
    cenario.orcamentos.orcamentos.set(ORCAMENTO_ID, orcamentoDeExemplo());
    cenario.pagamentos.pagamentos.set('p2', pagamentoDeExemplo({ id: 'p2' }));
    cenario.pagamentos.pagamentos.set(
      'p1',
      pagamentoDeExemplo({
        id: 'p1',
        status: 'ESTORNADO',
        registradoEm: new Date('2026-10-20T13:00:00.000Z'),
      }),
    );
    return new ConsultarOrcamentosUseCase(
      cenario.orcamentos,
      cenario.pagamentos,
    );
  }

  it('funcionário e cliente dono veem o orçamento da OS', async () => {
    const useCase = montar();

    expect(await useCase.listarDaOs(OS_ID, funcionario)).toHaveLength(1);
    expect(await useCase.listarDaOs(OS_ID, dono)).toHaveLength(1);
    expect((await useCase.buscar(ORCAMENTO_ID, dono)).id).toBe(ORCAMENTO_ID);
  });

  it('para outro cliente, o orçamento não existe', async () => {
    const useCase = montar();

    expect(await useCase.listarDaOs(OS_ID, outroCliente)).toEqual([]);
    await expect(
      useCase.buscar(ORCAMENTO_ID, outroCliente),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('OS sem orçamento devolve lista vazia; id inexistente é 404', async () => {
    const useCase = montar();

    expect(await useCase.listarDaOs('outra-os', funcionario)).toEqual([]);
    await expect(
      useCase.buscar('nao-existe', funcionario),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lista os pagamentos da OS, mais antigos primeiro', async () => {
    const useCase = montar();

    const pagamentos = await useCase.listarPagamentosDaOs(OS_ID);

    expect(pagamentos.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
