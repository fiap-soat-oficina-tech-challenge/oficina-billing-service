import {
  COBRANCA,
  orcamentoDeExemplo,
} from '../../application/use-case/testes-de-apoio';
import { LambdaEmailNotificador } from './lambda-email.notificador';

describe('LambdaEmailNotificador', () => {
  let fetchMock: jest.SpyInstance;
  const notificador = new LambdaEmailNotificador({
    url: 'https://api.oficina.test/mail',
    token: 'token-da-lambda',
  });

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => fetchMock.mockRestore());

  function corpoEnviado(): { to: string; subject: string; text: string } {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.oficina.test/mail');
    expect(init.headers).toMatchObject({
      'x-mail-api-token': 'token-da-lambda',
    });
    return JSON.parse(init.body as string) as {
      to: string;
      subject: string;
      text: string;
    };
  }

  it('envia o orçamento com as linhas, os totais e as rotas de aprovação', async () => {
    const orcamento = orcamentoDeExemplo({
      itens: [
        {
          referenciaId: 'i1',
          nome: 'Filtro de óleo',
          precoUnitario: 15.1,
          quantidade: 2,
          subtotal: 30.2,
        },
      ],
      valorPecas: 30.2,
      valorTotal: 150.2,
    });

    await notificador.enviarOrcamento(orcamento);

    const corpo = corpoEnviado();
    expect(corpo.to).toBe('maria@email.com');
    expect(corpo.subject).toBe('Orçamento OS OS-2026-000001 - Oficina SOAT');
    expect(corpo.text).toContain('Troca de óleo (x1): R$');
    expect(corpo.text).toContain('Filtro de óleo (x2): R$');
    expect(corpo.text).toMatch(/Total: R\$\s150,20/);
    expect(corpo.text).toContain(
      `POST /billing/orcamentos/${orcamento.id}/aprovar`,
    );
  });

  it('omite a seção sem linhas', async () => {
    await notificador.enviarOrcamento(orcamentoDeExemplo());

    expect(corpoEnviado().text).not.toContain('Peças e insumos:');
  });

  it('envia o link de pagamento com o prazo no horário de Brasília', async () => {
    await notificador.enviarLinkPagamento(
      orcamentoDeExemplo({ status: 'APROVADO', cobranca: COBRANCA }),
    );

    const corpo = corpoEnviado();
    expect(corpo.subject).toBe('Pagamento da OS OS-2026-000001 - Oficina SOAT');
    expect(corpo.text).toContain(COBRANCA.linkPagamento);
    expect(corpo.text).toContain('23/10/2026, 11:00');
  });

  it('sem link de pagamento, não envia', async () => {
    await notificador.enviarLinkPagamento(orcamentoDeExemplo());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cliente sem e-mail: não envia', async () => {
    await notificador.enviarOrcamento(
      orcamentoDeExemplo({
        cliente: { id: 'c1', nome: 'João', email: null },
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sem a Lambda configurada (ambiente local): não envia', async () => {
    await new LambdaEmailNotificador({}).enviarOrcamento(orcamentoDeExemplo());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'resposta de erro',
      () => Promise.resolve(new Response('', { status: 502 })),
    ],
    ['falha de rede', () => Promise.reject(new TypeError('fetch failed'))],
  ])('%s não interrompe a operação (best-effort)', async (_caso, falha) => {
    fetchMock.mockImplementation(falha);

    await expect(
      notificador.enviarOrcamento(orcamentoDeExemplo()),
    ).resolves.toBeUndefined();
  });
});
