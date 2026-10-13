import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  WEBHOOK_TOKEN_HEADER,
  WebhookTokenGuard,
} from '../../../../common/guards';
import {
  NotificacaoMercadoPagoResponseDto,
  OrcamentoResponseDto,
  WebhookOrcamentoDto,
} from '../../application/dto/orcamento.dto';
import { DecidirOrcamentoUseCase } from '../../application/use-case/decidir-orcamento.use-case';
import { ProcessarNotificacaoPagamentoUseCase } from '../../application/use-case/processar-notificacao-pagamento.use-case';
import { apresentarOrcamento } from '../presenter/orcamento.presenter';

/**
 * Lê o id do pagamento de um aviso do Mercado Pago. O aviso pode vir no formato
 * de webhook (corpo `{ type: "payment", data: { id } }` e query
 * `?type=payment&data.id=...`) ou no formato antigo de IPN
 * (`?topic=payment&id=...`). Avisos de outros tópicos devolvem null.
 */
export function lerAvisoMercadoPago(
  query: Record<string, unknown>,
  corpo: Record<string, unknown> | undefined,
): string | null {
  const dados = corpo?.data as Record<string, unknown> | undefined;
  const topico = corpo?.type ?? query.type ?? query.topic;
  const id = dados?.id ?? query['data.id'] ?? query.id;

  if (topico !== 'payment') return null;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  return String(id);
}

/** Chamadas de fora: o sistema externo de aprovação e o Mercado Pago. */
@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly decidir: DecidirOrcamentoUseCase,
    private readonly processarNotificacao: ProcessarNotificacaoPagamentoUseCase,
  ) {}

  @Post('orcamento')
  @UseGuards(WebhookTokenGuard)
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: WEBHOOK_TOKEN_HEADER,
    description: 'Token compartilhado com o sistema externo',
    required: true,
  })
  @ApiOperation({
    summary: 'Aprovação ou recusa do orçamento pelo sistema externo',
    description:
      'Mesmo corpo do webhook do OS Service na Fase 3; só a URL mudou. Na aprovação, o link de pagamento é criado e enviado ao cliente por e-mail.',
  })
  @ApiOkResponse({ type: OrcamentoResponseDto })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido' })
  @ApiResponse({ status: 404, description: 'A OS não tem orçamento' })
  @ApiResponse({
    status: 409,
    description: 'O orçamento não está aguardando aprovação',
  })
  @ApiResponse({
    status: 503,
    description: 'Mercado Pago indisponível; nada mudou, tente de novo',
  })
  async decidirOrcamento(
    @Body() dto: WebhookOrcamentoDto,
  ): Promise<OrcamentoResponseDto> {
    const orcamento = await this.decidir.peloSistemaExterno(
      dto.codigoOS,
      dto.aprovado
        ? { aprovado: true }
        : { aprovado: false, motivo: dto.motivo ?? null },
    );
    return apresentarOrcamento(orcamento);
  }

  /**
   * Rota pública: o Mercado Pago não manda token. A proteção é nunca confiar no
   * conteúdo do aviso — o pagamento é sempre consultado na API do Mercado Pago.
   * O corpo é lido sem DTO de propósito: o aviso traz campos que mudam com a
   * versão da API, e recusá-lo faria o Mercado Pago reenviar para sempre.
   */
  @Post('mercado-pago')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aviso de pagamento do Mercado Pago',
    description:
      'Só trata o tópico payment. Confirma o pagamento em GET /v1/payments/{id} e avisa o orquestrador. Responde 200 também para avisos ignorados ou repetidos; erro faz o Mercado Pago reenviar.',
  })
  @ApiBody({
    schema: {
      example: {
        type: 'payment',
        action: 'payment.updated',
        data: { id: '123456789' },
      },
    },
  })
  @ApiOkResponse({ type: NotificacaoMercadoPagoResponseDto })
  async notificacaoMercadoPago(
    @Query() query: Record<string, unknown>,
    @Body() corpo: Record<string, unknown>,
  ): Promise<NotificacaoMercadoPagoResponseDto> {
    const pagamentoId = lerAvisoMercadoPago(query, corpo);
    if (!pagamentoId) return { resultado: 'IGNORADO' };
    return { resultado: await this.processarNotificacao.execute(pagamentoId) };
  }
}
