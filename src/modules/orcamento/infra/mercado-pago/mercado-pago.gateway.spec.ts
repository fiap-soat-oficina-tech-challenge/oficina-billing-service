import { GatewayPagamentoError } from '../../application/ports/gateway-pagamento';
import { orcamentoDeExemplo } from '../../application/use-case/testes-de-apoio';
import { MercadoPagoGateway, TENTATIVAS } from './mercado-pago.gateway';

function resposta(status: number, corpo: unknown = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('MercadoPagoGateway', () => {
  let fetchMock: jest.SpyInstance;
  const config = {
    apiUrl: 'https://api.mp.test',
    accessToken: 'TEST-token',
    notificationUrl: 'https://api.oficina.test/billing/webhooks/mercado-pago',
    usarSandbox: true,
  };
  const gateway = new MercadoPagoGateway(config, 0);

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  function chamada(indice = 0): { url: string; init: RequestInit } {
    const [url, init] = fetchMock.mock.calls[indice] as [string, RequestInit];
    return { url, init };
  }

  describe('criarCobranca', () => {
    it('cria a preferência do Checkout Pro e devolve o link de sandbox', async () => {
      fetchMock.mockResolvedValue(
        resposta(201, {
          id: 'pref-123',
          init_point: 'https://www.mercadopago.com.br/checkout?pref=123',
          sandbox_init_point:
            'https://sandbox.mercadopago.com.br/checkout?pref=123',
        }),
      );
      const expiraEm = new Date('2026-10-23T14:00:00.000Z');
      const orcamento = orcamentoDeExemplo({ valorTotal: 150.2 });

      const cobranca = await gateway.criarCobranca(orcamento, expiraEm);

      expect(cobranca).toEqual({
        preferenciaId: 'pref-123',
        linkPagamento: 'https://sandbox.mercadopago.com.br/checkout?pref=123',
        expiraEm,
      });
      const { url, init } = chamada();
      expect(url).toBe('https://api.mp.test/checkout/preferences');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer TEST-token',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        items: [
          {
            id: orcamento.id,
            title: 'Orçamento da OS OS-2026-000001 - Oficina SOAT',
            quantity: 1,
            unit_price: 150.2,
            currency_id: 'BRL',
          },
        ],
        external_reference: orcamento.id,
        notification_url: config.notificationUrl,
        expires: true,
        expiration_date_to: '2026-10-23T14:00:00.000+00:00',
      });
    });

    it('fora do sandbox usa o init_point', async () => {
      fetchMock.mockResolvedValue(
        resposta(201, {
          id: 'p',
          init_point: 'https://producao',
          sandbox_init_point: 'https://sandbox',
        }),
      );
      const producao = new MercadoPagoGateway(
        { ...config, usarSandbox: false },
        0,
      );

      const cobranca = await producao.criarCobranca(
        orcamentoDeExemplo(),
        new Date(),
      );

      expect(cobranca.linkPagamento).toBe('https://producao');
    });
  });

  it('expirarCobranca põe o prazo da preferência no passado', async () => {
    fetchMock.mockResolvedValue(resposta(200, {}));

    await gateway.expirarCobranca(
      'pref-123',
      new Date('2026-10-20T14:00:00.000Z'),
    );

    const { url, init } = chamada();
    expect(url).toBe('https://api.mp.test/checkout/preferences/pref-123');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      expires: true,
      expiration_date_to: '2026-10-20T13:59:00.000+00:00',
    });
  });

  describe('consultarPagamento', () => {
    it.each([
      ['approved', 'APROVADO'],
      ['rejected', 'RECUSADO'],
      ['in_process', 'OUTRA'],
      ['refunded', 'OUTRA'],
    ])('traduz o status %s para %s', async (status, situacao) => {
      fetchMock.mockResolvedValue(
        resposta(200, {
          id: 1234567890,
          status,
          status_detail: 'accredited',
          external_reference: 'orc-1',
          transaction_amount: 150.2,
          date_approved: '2026-10-20T14:30:00.000-03:00',
        }),
      );

      const pagamento = await gateway.consultarPagamento('1234567890');

      expect(chamada().url).toBe('https://api.mp.test/v1/payments/1234567890');
      expect(pagamento).toEqual({
        id: '1234567890',
        situacao,
        statusOriginal: status,
        detalhe: 'accredited',
        orcamentoId: 'orc-1',
        valor: 150.2,
        pagoEm: new Date('2026-10-20T17:30:00.000Z'),
      });
    });

    it('campos opcionais ausentes viram null', async () => {
      fetchMock.mockResolvedValue(
        resposta(200, { id: 1, status: 'rejected', transaction_amount: 10 }),
      );

      expect(await gateway.consultarPagamento('1')).toMatchObject({
        detalhe: null,
        orcamentoId: null,
        pagoEm: null,
      });
    });

    it('pagamento que o Mercado Pago não conhece devolve null, sem nova tentativa', async () => {
      fetchMock.mockResolvedValue(resposta(404, { message: 'not found' }));

      await expect(gateway.consultarPagamento('123456')).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('estornar manda a chave de idempotência fixa do pagamento', async () => {
    fetchMock.mockResolvedValue(
      resposta(201, {
        id: 99,
        status: 'approved',
        date_created: '2026-10-20T15:00:00.000-03:00',
      }),
    );

    const { estornadoEm } = await gateway.estornar('1234567890');

    const { url, init } = chamada();
    expect(url).toBe('https://api.mp.test/v1/payments/1234567890/refunds');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'X-Idempotency-Key': 'estorno-1234567890',
    });
    expect(estornadoEm).toEqual(new Date('2026-10-20T18:00:00.000Z'));
  });

  it('estorno sem data na resposta usa o momento atual', async () => {
    fetchMock.mockResolvedValue(resposta(201, { id: 99 }));

    const { estornadoEm } = await gateway.estornar('1');

    expect(estornadoEm).toBeInstanceOf(Date);
  });

  describe('timeout e nova tentativa', () => {
    it('repete depois de erro de rede e devolve a segunda resposta', async () => {
      fetchMock
        .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
        .mockResolvedValueOnce(resposta(201, { id: 99 }));

      await expect(gateway.estornar('1')).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(chamada().init.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([429, 500, 503])(
      'repete em HTTP %s e desiste depois das tentativas',
      async (status) => {
        fetchMock.mockImplementation(() => Promise.resolve(resposta(status)));

        await expect(gateway.estornar('1')).rejects.toThrow(
          new GatewayPagamentoError('estornar o pagamento', `HTTP ${status}`),
        );
        expect(fetchMock).toHaveBeenCalledTimes(TENTATIVAS);
      },
    );

    it('não repete em 4xx: pedido errado ou credencial inválida', async () => {
      fetchMock.mockResolvedValue(resposta(401, { message: 'invalid token' }));

      await expect(
        gateway.criarCobranca(orcamentoDeExemplo(), new Date()),
      ).rejects.toBeInstanceOf(GatewayPagamentoError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falha de rede em todas as tentativas vira GatewayPagamentoError', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(gateway.consultarPagamento('1')).rejects.toThrow(
        'Falha no Mercado Pago ao consultar o pagamento: TypeError',
      );
    });

    it('registra erro que não é Error pelo texto', async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      fetchMock.mockImplementation(() => Promise.reject('desconectado'));

      await expect(gateway.estornar('1')).rejects.toThrow('desconectado');
    });
  });
});
