import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GatewayPagamentoError } from '../ports/gateway-pagamento';
import {
  DecidirOrcamentoUseCase,
  PRAZO_DA_COBRANCA_EM_HORAS,
} from './decidir-orcamento.use-case';
import {
  AGORA,
  CLIENTE_ID,
  criarCenario,
  ORCAMENTO_ID,
  orcamentoDeExemplo,
  OS_ID,
} from './testes-de-apoio';

describe('DecidirOrcamentoUseCase', () => {
  function montar() {
    const cenario = criarCenario();
    cenario.orcamentos.orcamentos.set(ORCAMENTO_ID, orcamentoDeExemplo());
    const useCase = new DecidirOrcamentoUseCase(
      cenario.orcamentos,
      cenario.transacao,
      cenario.publicador,
      cenario.gateway,
      cenario.notificador,
    );
    return { ...cenario, useCase };
  }

  describe('aprovação pelo cliente', () => {
    it('cria a cobrança (QR Code), aprova, avisa a Saga e envia o QR Code por e-mail', async () => {
      const { useCase, orcamentos, publicador, gateway, notificador } =
        montar();

      const aprovado = await useCase.peloCliente(
        ORCAMENTO_ID,
        CLIENTE_ID,
        { aprovado: true },
        AGORA,
      );

      expect(gateway.chamadas).toEqual([
        `criarCobranca:${ORCAMENTO_ID}:${PRAZO_DA_COBRANCA_EM_HORAS}h`,
      ]);
      expect(aprovado).toMatchObject({
        status: 'APROVADO',
        origemDecisao: 'CLIENTE',
        decididoEm: AGORA,
        cobranca: {
          id: `ORD-${ORCAMENTO_ID}`,
          expiraEm: new Date(
            AGORA.getTime() + PRAZO_DA_COBRANCA_EM_HORAS * 3_600_000,
          ),
        },
      });
      expect(await orcamentos.buscarPorId(ORCAMENTO_ID)).toEqual(aprovado);
      expect(publicador.publicadas).toEqual([
        expect.objectContaining({
          tipo: 'OrcamentoAprovado',
          osId: OS_ID,
          correlationId: 'fluxo-da-os',
          payload: { orcamentoId: ORCAMENTO_ID, origem: 'CLIENTE' },
        }),
      ]);
      expect(notificador.enviados).toEqual([`cobranca:${ORCAMENTO_ID}`]);
    });

    it('Mercado Pago fora: responde 503 e nada muda', async () => {
      const { useCase, orcamentos, publicador, gateway, notificador } =
        montar();
      gateway.falha = new GatewayPagamentoError('criar a cobrança', 'HTTP 500');

      await expect(
        useCase.peloCliente(ORCAMENTO_ID, CLIENTE_ID, { aprovado: true }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(
        'AGUARDANDO_APROVACAO',
      );
      expect(publicador.publicadas).toHaveLength(0);
      expect(notificador.enviados).toHaveLength(0);
    });

    it('orçamento de outro cliente é 404', async () => {
      const { useCase } = montar();

      await expect(
        useCase.peloCliente(ORCAMENTO_ID, 'outro-cliente', { aprovado: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('orçamento inexistente é 404', async () => {
      const { useCase } = montar();

      await expect(
        useCase.peloCliente('nao-existe', CLIENTE_ID, { aprovado: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('orçamento já decidido é 409, sem chamar o Mercado Pago', async () => {
      const { useCase, orcamentos, gateway } = montar();
      orcamentos.orcamentos.set(
        ORCAMENTO_ID,
        orcamentoDeExemplo({ status: 'RECUSADO' }),
      );

      await expect(
        useCase.peloCliente(ORCAMENTO_ID, CLIENTE_ID, { aprovado: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(gateway.chamadas).toHaveLength(0);
    });

    it('outra decisão chegou no meio: 409 e nada é publicado', async () => {
      const { useCase, orcamentos, publicador } = montar();
      // Simula a corrida: entre a leitura e a gravação, o orçamento muda.
      jest.spyOn(orcamentos, 'atualizar').mockResolvedValueOnce(false);

      await expect(
        useCase.peloCliente(ORCAMENTO_ID, CLIENTE_ID, { aprovado: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(publicador.publicadas).toHaveLength(0);
    });

    it('se a publicação falha, o orçamento continua aguardando aprovação', async () => {
      const { useCase, orcamentos, publicador } = montar();
      publicador.falhar = true;

      await expect(
        useCase.peloCliente(ORCAMENTO_ID, CLIENTE_ID, { aprovado: true }),
      ).rejects.toThrow('SQS fora');
      expect((await orcamentos.buscarPorId(ORCAMENTO_ID))?.status).toBe(
        'AGUARDANDO_APROVACAO',
      );
    });
  });

  describe('recusa pelo cliente', () => {
    it('recusa com o motivo, avisa a Saga e não cria cobrança', async () => {
      const { useCase, publicador, gateway, notificador } = montar();

      const recusado = await useCase.peloCliente(
        ORCAMENTO_ID,
        CLIENTE_ID,
        { aprovado: false, motivo: 'Caro demais' },
        AGORA,
      );

      expect(recusado).toMatchObject({
        status: 'RECUSADO',
        origemDecisao: 'CLIENTE',
        motivoRecusa: 'Caro demais',
        cobranca: null,
      });
      expect(publicador.publicadas[0]).toMatchObject({
        tipo: 'OrcamentoRecusado',
        payload: {
          orcamentoId: ORCAMENTO_ID,
          origem: 'CLIENTE',
          motivo: 'Caro demais',
        },
      });
      expect(gateway.chamadas).toHaveLength(0);
      expect(notificador.enviados).toHaveLength(0);
    });
  });

  describe('decisão pelo sistema externo', () => {
    it('acha o orçamento pelo código da OS e marca a origem SISTEMA_EXTERNO', async () => {
      const { useCase, publicador } = montar();

      const aprovado = await useCase.peloSistemaExterno('OS-2026-000001', {
        aprovado: true,
      });

      expect(aprovado.origemDecisao).toBe('SISTEMA_EXTERNO');
      expect(publicador.publicadas[0].payload).toEqual({
        orcamentoId: ORCAMENTO_ID,
        origem: 'SISTEMA_EXTERNO',
      });
    });

    it('recusa sem motivo publica motivo null', async () => {
      const { useCase, publicador } = montar();

      await useCase.peloSistemaExterno('OS-2026-000001', {
        aprovado: false,
        motivo: null,
      });

      expect(publicador.publicadas[0].payload).toEqual({
        orcamentoId: ORCAMENTO_ID,
        origem: 'SISTEMA_EXTERNO',
        motivo: null,
      });
    });

    it('OS sem orçamento é 404', async () => {
      const { useCase } = montar();

      await expect(
        useCase.peloSistemaExterno('OS-2026-999999', { aprovado: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
