import { payloadGerarOrcamento } from '../use-case/testes-de-apoio';
import {
  lerComandoGerarOrcamento,
  ORCAMENTO_VAZIO,
} from './ler-comando-gerar-orcamento';

describe('lerComandoGerarOrcamento', () => {
  it('lê o payload do contrato, trocando os ids das linhas por referenciaId', () => {
    expect(lerComandoGerarOrcamento(payloadGerarOrcamento())).toEqual({
      codigo: 'OS-2026-000001',
      cliente: {
        id: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
        nome: 'Maria Silva',
        email: 'maria@email.com',
      },
      servicos: [
        {
          referenciaId: 'srv-1',
          nome: 'Troca de óleo',
          precoUnitario: 120,
          quantidade: 1,
          subtotal: 120,
        },
      ],
      itens: [
        {
          referenciaId: 'item-1',
          nome: 'Filtro de óleo',
          precoUnitario: 15.1,
          quantidade: 2,
          subtotal: 30.2,
        },
      ],
      valorServicos: 120,
      valorPecas: 30.2,
      valorTotal: 150.2,
    });
  });

  it('aceita cliente sem e-mail e lista de itens ausente', () => {
    const payload = payloadGerarOrcamento();
    payload.cliente = { id: 'c1', nome: 'João', email: null };
    delete payload.itens;
    payload.valorPecas = 0;
    payload.valorTotal = 120;

    const dados = lerComandoGerarOrcamento(payload);

    expect(dados).toMatchObject({
      cliente: { id: 'c1', nome: 'João', email: null },
      itens: [],
      valorTotal: 120,
    });
  });

  it('OS sem nenhum serviço nem item é ORCAMENTO_VAZIO', () => {
    const payload = {
      ...payloadGerarOrcamento(),
      servicos: [],
      itens: [],
      valorServicos: 0,
      valorPecas: 0,
      valorTotal: 0,
    };

    expect(lerComandoGerarOrcamento(payload)).toEqual({
      motivo: ORCAMENTO_VAZIO,
    });
  });

  const casosInvalidos: [string, (p: Record<string, unknown>) => void][] = [
    ['sem código', (p) => delete p.codigo],
    ['sem cliente', (p) => delete p.cliente],
    ['cliente sem nome', (p) => (p.cliente = { id: 'c1' })],
    ['serviços que não são lista', (p) => (p.servicos = 'troca de óleo')],
    [
      'linha sem id',
      (p) =>
        (p.servicos = [
          { nome: 'X', precoUnitario: 1, quantidade: 1, subtotal: 1 },
        ]),
    ],
    [
      'quantidade fracionada',
      (p) =>
        (p.itens = [
          {
            itemEstoqueId: 'i',
            nome: 'X',
            precoUnitario: 1,
            quantidade: 1.5,
            subtotal: 1.5,
          },
        ]),
    ],
    [
      'preço negativo',
      (p) =>
        (p.itens = [
          {
            itemEstoqueId: 'i',
            nome: 'X',
            precoUnitario: -1,
            quantidade: 1,
            subtotal: -1,
          },
        ]),
    ],
    [
      'subtotal diferente de preço × quantidade',
      (p) =>
        (p.itens = [
          {
            itemEstoqueId: 'i',
            nome: 'Filtro',
            precoUnitario: 15.1,
            quantidade: 2,
            subtotal: 30,
          },
        ]),
    ],
    ['sem valorTotal', (p) => delete p.valorTotal],
    ['valorServicos que não fecha', (p) => (p.valorServicos = 100)],
    ['valorPecas que não fecha', (p) => (p.valorPecas = 30)],
    ['valorTotal que não fecha', (p) => (p.valorTotal = 150)],
  ];

  it.each(casosInvalidos)('recusa comando %s', (_caso, estragar) => {
    const payload = payloadGerarOrcamento();
    estragar(payload);

    const resultado = lerComandoGerarOrcamento(payload);

    expect(resultado).toEqual({
      motivo: expect.stringMatching(/^COMANDO_INVALIDO: /) as string,
    });
  });
});
