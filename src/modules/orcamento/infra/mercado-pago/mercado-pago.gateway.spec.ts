import { GatewayPagamentoError } from '../../application/ports/gateway-pagamento';
import {
  ORCAMENTO_ID,
  orcamentoDeExemplo,
} from '../../application/use-case/testes-de-apoio';
import { MercadoPagoGateway, TENTATIVAS } from './mercado-pago.gateway';

function resposta(status: number, corpo: unknown = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ORDER_ID = 'ORD01JV3AW3NFSTSTB669F41NACDX';
const QR_DATA =
  '00020101021243650016COM.MERCADOLIBRE02013063638f1192a5204000053039865802BR63041D4F';

describe('MercadoPagoGateway', () => {
  let fetchMock: jest.SpyInstance;
  const gateway = new MercadoPagoGateway(
    {
      apiUrl: 'https://api.mp.test',
      accessToken: 'APP_USR-token',
      caixaId: 'OFICINA01CAIXA01',
    },
    0,
  );

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  function chamada(indice = 0): { url: string; init: RequestInit } {
    const [url, init] = fetchMock.mock.calls[indice] as [string, RequestInit];
    return { url, init };
  }

  describe('criarCobranca', () => {
    const agora = new Date('2026-10-20T14:00:00.000Z');

    it('cria a order de QR Code dinâmico no caixa e devolve o QR Code', async () => {
      fetchMock.mockResolvedValue(
        resposta(201, {
          id: ORDER_ID,
          status: 'created',
          type_response: { qr_data: QR_DATA },
        }),
      );
      const orcamento = orcamentoDeExemplo({ valorTotal: 150.2 });

      const cobranca = await gateway.criarCobranca(orcamento, 72, agora);

      expect(cobranca).toEqual({
        id: ORDER_ID,
        qrCode: QR_DATA,
        expiraEm: new Date('2026-10-23T14:00:00.000Z'),
      });
      const { url, init } = chamada();
      expect(url).toBe('https://api.mp.test/v1/orders');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer APP_USR-token',
        'X-Idempotency-Key': `cobranca-${ORCAMENTO_ID}`,
      });
      expect(JSON.parse(init.body as string)).toEqual({
        type: 'qr',
        total_amount: '150.20',
        description: 'Orçamento da OS OS-2026-000001 - Oficina SOAT',
        external_reference: ORCAMENTO_ID,
        expiration_time: 'PT72H',
        config: {
          qr: { external_pos_id: 'OFICINA01CAIXA01', mode: 'dynamic' },
        },
        transactions: { payments: [{ amount: '150.20' }] },
      });
    });

    it('resposta sem o QR Code vira GatewayPagamentoError', async () => {
      fetchMock.mockResolvedValue(resposta(201, { id: ORDER_ID }));

      await expect(
        gateway.criarCobranca(orcamentoDeExemplo(), 72, agora),
      ).rejects.toThrow(
        'Falha no Mercado Pago ao criar a cobrança: resposta sem type_response.qr_data',
      );
    });
  });

  describe('cancelarCobranca', () => {
    it('cancela a order, sem corpo e com chave de idempotência', async () => {
      fetchMock.mockResolvedValue(resposta(200, { status: 'canceled' }));

      await gateway.cancelarCobranca(ORDER_ID);

      const { url, init } = chamada();
      expect(url).toBe(`https://api.mp.test/v1/orders/${ORDER_ID}/cancel`);
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      expect(init.headers).toMatchObject({
        'X-Idempotency-Key': `cancelamento-${ORDER_ID}`,
      });
    });

    it('order que já não aceita pagamento (paga, expirada, cancelada) não é erro', async () => {
      fetchMock.mockResolvedValue(
        resposta(409, {
          errors: [
            {
              code: 'cannot_cancel_order',
              message:
                "the order cannot be canceled because the current status, 'processed', doesn't allow cancelation",
            },
          ],
        }),
      );

      await expect(gateway.cancelarCobranca(ORDER_ID)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('order travada por um pagamento em andamento é erro (a fila repete)', async () => {
      fetchMock.mockResolvedValue(
        resposta(409, { errors: [{ code: 'instore_order_locked_error' }] }),
      );

      await expect(gateway.cancelarCobranca(ORDER_ID)).rejects.toThrow(
        'Falha no Mercado Pago ao cancelar a cobrança: HTTP 409 (instore_order_locked_error)',
      );
    });

    it('409 sem corpo de erro legível é erro', async () => {
      fetchMock.mockResolvedValue(new Response('conflito', { status: 409 }));

      await expect(gateway.cancelarCobranca(ORDER_ID)).rejects.toThrow(
        'Falha no Mercado Pago ao cancelar a cobrança: HTTP 409',
      );
    });
  });

  describe('consultarPagamento', () => {
    it('order paga vira APROVADO, com o valor pago e a referência do orçamento', async () => {
      fetchMock.mockResolvedValue(
        resposta(200, {
          id: ORDER_ID,
          status: 'processed',
          status_detail: 'accredited',
          external_reference: ORCAMENTO_ID,
          total_amount: '150.20',
          total_paid_amount: '150.20',
          last_updated_date: '2026-10-20T14:31:08.155Z',
        }),
      );

      const pagamento = await gateway.consultarPagamento(ORDER_ID);

      expect(chamada().url).toBe(`https://api.mp.test/v1/orders/${ORDER_ID}`);
      expect(chamada().init.method).toBe('GET');
      expect(pagamento).toEqual({
        id: ORDER_ID,
        situacao: 'APROVADO',
        statusOriginal: 'processed',
        detalhe: 'accredited',
        orcamentoId: ORCAMENTO_ID,
        valor: 150.2,
        pagoEm: new Date('2026-10-20T14:31:08.155Z'),
      });
    });

    it.each(['created', 'canceled', 'expired', 'refunded'])(
      'order %s vira OUTRA, sem data de pagamento',
      async (status) => {
        fetchMock.mockResolvedValue(
          resposta(200, {
            id: ORDER_ID,
            status,
            total_amount: '150.20',
            last_updated_date: '2026-10-20T14:31:08.155Z',
          }),
        );

        await expect(gateway.consultarPagamento(ORDER_ID)).resolves.toEqual({
          id: ORDER_ID,
          situacao: 'OUTRA',
          statusOriginal: status,
          detalhe: null,
          orcamentoId: null,
          valor: 150.2,
          pagoEm: null,
        });
      },
    );

    it.each([404, 400])(
      'order desconhecida (HTTP %s) é null — o aviso simulado do painel manda um id inválido',
      async (status) => {
        fetchMock.mockResolvedValue(resposta(status));

        await expect(gateway.consultarPagamento('123456')).resolves.toBeNull();
      },
    );

    it('credencial inválida é erro', async () => {
      fetchMock.mockResolvedValue(resposta(401));

      await expect(gateway.consultarPagamento(ORDER_ID)).rejects.toThrow(
        'Falha no Mercado Pago ao consultar a cobrança: HTTP 401',
      );
    });
  });

  describe('estornar', () => {
    it('estorna o total da order, sem corpo e com chave de idempotência', async () => {
      fetchMock.mockResolvedValue(
        resposta(201, {
          id: ORDER_ID,
          transactions: { refunds: [{ status: 'processing' }] },
        }),
      );

      const { estornadoEm } = await gateway.estornar(ORDER_ID);

      const { url, init } = chamada();
      expect(url).toBe(`https://api.mp.test/v1/orders/${ORDER_ID}/refund`);
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();
      expect(init.headers).toMatchObject({
        'X-Idempotency-Key': `estorno-${ORDER_ID}`,
      });
      expect(estornadoEm).toBeInstanceOf(Date);
    });

    it('estorno repetido depois que a chave expirou: 409 com a order já estornada é sucesso', async () => {
      fetchMock
        .mockResolvedValueOnce(
          resposta(409, { errors: [{ code: 'conflict' }] }),
        )
        .mockResolvedValueOnce(
          resposta(200, {
            id: ORDER_ID,
            status: 'refunded',
            total_amount: '1',
          }),
        );

      await expect(gateway.estornar(ORDER_ID)).resolves.toBeDefined();
      expect(chamada(1).url).toBe(`https://api.mp.test/v1/orders/${ORDER_ID}`);
    });

    it('409 com a order ainda paga é erro', async () => {
      fetchMock
        .mockResolvedValueOnce(
          resposta(409, { errors: [{ code: 'conflict' }] }),
        )
        .mockResolvedValueOnce(
          resposta(200, {
            id: ORDER_ID,
            status: 'processed',
            total_amount: '1',
          }),
        );

      await expect(gateway.estornar(ORDER_ID)).rejects.toThrow(
        'Falha no Mercado Pago ao estornar o pagamento: HTTP 409 (conflict)',
      );
    });

    it('outro 4xx é erro, sem consultar a order', async () => {
      fetchMock.mockResolvedValue(resposta(400));

      await expect(gateway.estornar(ORDER_ID)).rejects.toThrow('HTTP 400');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('timeout e nova tentativa', () => {
    it('repete depois de erro de rede e devolve a segunda resposta', async () => {
      fetchMock
        .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'))
        .mockResolvedValueOnce(resposta(201, { id: ORDER_ID }));

      await expect(gateway.estornar(ORDER_ID)).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(chamada().init.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([429, 500, 503])(
      'repete em HTTP %s e desiste depois das tentativas',
      async (status) => {
        fetchMock.mockImplementation(() => Promise.resolve(resposta(status)));

        await expect(gateway.estornar(ORDER_ID)).rejects.toThrow(
          new GatewayPagamentoError('estornar o pagamento', `HTTP ${status}`),
        );
        expect(fetchMock).toHaveBeenCalledTimes(TENTATIVAS);
      },
    );

    it('não repete em 4xx: pedido errado ou credencial inválida', async () => {
      fetchMock.mockResolvedValue(resposta(401, { message: 'invalid token' }));

      await expect(
        gateway.criarCobranca(orcamentoDeExemplo(), 72, new Date()),
      ).rejects.toBeInstanceOf(GatewayPagamentoError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falha de rede em todas as tentativas vira GatewayPagamentoError', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(gateway.consultarPagamento(ORDER_ID)).rejects.toThrow(
        'Falha no Mercado Pago ao consultar a cobrança: TypeError',
      );
    });

    it('registra erro que não é Error pelo texto', async () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      fetchMock.mockImplementation(() => Promise.reject('desconectado'));

      await expect(gateway.estornar(ORDER_ID)).rejects.toThrow('desconectado');
    });
  });
});
