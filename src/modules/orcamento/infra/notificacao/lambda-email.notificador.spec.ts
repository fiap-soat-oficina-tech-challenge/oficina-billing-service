import {
  COBRANCA,
  orcamentoDeExemplo,
} from '../../application/use-case/testes-de-apoio';
import {
  CID_QR_CODE,
  LambdaEmailNotificador,
} from './lambda-email.notificador';

interface CorpoEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: {
    filename: string;
    contentType: string;
    content: string;
    cid: string;
  }[];
}

/** Assinatura de todo arquivo PNG. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

  function corpoEnviado(): CorpoEmail {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.oficina.test/mail');
    expect(init.headers).toMatchObject({
      'x-mail-api-token': 'token-da-lambda',
    });
    return JSON.parse(init.body as string) as CorpoEmail;
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
    expect(corpo.text).toContain('você recebe o QR Code de pagamento');
    expect(corpo.html).toBeUndefined();
    expect(corpo.attachments).toBeUndefined();
  });

  it('omite a seção sem linhas', async () => {
    await notificador.enviarOrcamento(orcamentoDeExemplo());

    expect(corpoEnviado().text).not.toContain('Peças e insumos:');
  });

  it('envia o QR Code como imagem embutida no HTML, com o prazo no horário de Brasília', async () => {
    const orcamento = orcamentoDeExemplo({
      status: 'APROVADO',
      cobranca: COBRANCA,
    });

    await notificador.enviarCobranca(orcamento);

    const corpo = corpoEnviado();
    expect(corpo.subject).toBe('Pagamento da OS OS-2026-000001 - Oficina SOAT');
    expect(corpo.text).toContain('23/10/2026, 11:00');
    expect(corpo.text).toContain(`GET /billing/orcamentos/${orcamento.id}`);
    expect(corpo.html).toContain(`<img src="cid:${CID_QR_CODE}"`);
    expect(corpo.html).toContain('23/10/2026, 11:00');
    expect(corpo.attachments).toHaveLength(1);
    const [imagem] = corpo.attachments ?? [];
    expect(imagem).toMatchObject({
      filename: 'qrcode-pagamento.png',
      contentType: 'image/png',
      cid: CID_QR_CODE,
    });
    expect(Buffer.from(imagem.content, 'base64').subarray(0, 8)).toEqual(PNG);
  });

  it('escapa no HTML o que vem do cadastro do cliente', async () => {
    await notificador.enviarCobranca(
      orcamentoDeExemplo({
        cliente: { id: 'c1', nome: 'Ana <b>"&\'</b>', email: 'ana@email.com' },
        cobranca: COBRANCA,
      }),
    );

    const corpo = corpoEnviado();
    expect(corpo.html).toContain(
      'Olá Ana &lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;,',
    );
    expect(corpo.html).not.toContain('<b>');
    expect(corpo.text).toContain('Olá Ana <b>"&\'</b>,');
  });

  it('sem cobrança, não envia', async () => {
    await notificador.enviarCobranca(orcamentoDeExemplo());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falha ao gerar a imagem do QR Code não interrompe a operação (best-effort)', async () => {
    await expect(
      notificador.enviarCobranca(
        orcamentoDeExemplo({
          cobranca: { ...COBRANCA, qrCode: 'x'.repeat(8000) },
        }),
      ),
    ).resolves.toBeUndefined();
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
