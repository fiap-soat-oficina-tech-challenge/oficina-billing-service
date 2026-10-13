import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  ORIGENS_DECISAO,
  STATUS_ORCAMENTO,
  type OrigemDecisao,
  type StatusOrcamento,
} from '../../domain/orcamento';
import { STATUS_PAGAMENTO, type StatusPagamento } from '../../domain/pagamento';

const CODIGO_OS_REGEX = /^OS-\d{4}-\d{6}$/;

// ─── Entradas ────────────────────────────────────────────────────────────────

export class FiltroPorOsQueryDto {
  @ApiProperty({ description: 'Id da OS', format: 'uuid' })
  @IsUUID()
  osId!: string;
}

export class RecusarOrcamentoDto {
  @ApiPropertyOptional({
    description: 'Por que o orçamento foi recusado',
    example: 'Valor acima do esperado',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  motivo?: string;
}

/** Corpo do webhook de aprovação externa: o mesmo formato do OS Service na Fase 3. */
export class WebhookOrcamentoDto {
  @ApiProperty({
    description: 'Código da OS no formato OS-YYYY-NNNNNN',
    example: 'OS-2026-000001',
  })
  @IsString()
  @Matches(CODIGO_OS_REGEX, {
    message: 'codigoOS deve estar no formato OS-YYYY-NNNNNN',
  })
  codigoOS!: string;

  @ApiProperty({
    description: 'true para aprovar, false para recusar o orçamento',
    example: true,
  })
  @IsBoolean()
  aprovado!: boolean;

  @ApiPropertyOptional({
    description: 'Motivo da recusa',
    example: 'Cliente desistiu do serviço',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  motivo?: string;
}

// ─── Respostas ───────────────────────────────────────────────────────────────

class ClienteResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Maria Silva' }) nome!: string;
  @ApiProperty({ nullable: true, type: String, example: 'maria@email.com' })
  email!: string | null;
}

class LinhaServicoResponseDto {
  @ApiProperty({ description: 'Id do serviço no OS Service' })
  servicoId!: string;
  @ApiProperty({ example: 'Troca de óleo' }) nome!: string;
  @ApiProperty({ example: 120 }) precoUnitario!: number;
  @ApiProperty({ example: 1 }) quantidade!: number;
  @ApiProperty({ example: 120 }) subtotal!: number;
}

class LinhaItemResponseDto {
  @ApiProperty({ description: 'Id do item de estoque no OS Service' })
  itemEstoqueId!: string;
  @ApiProperty({ example: 'Filtro de óleo' }) nome!: string;
  @ApiProperty({ example: 30 }) precoUnitario!: number;
  @ApiProperty({ example: 1 }) quantidade!: number;
  @ApiProperty({ example: 30 }) subtotal!: number;
}

export class OrcamentoResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() osId!: string;
  @ApiProperty({ example: 'OS-2026-000001' }) codigoOS!: string;
  @ApiProperty({ enum: STATUS_ORCAMENTO }) status!: StatusOrcamento;
  @ApiProperty({ type: ClienteResponseDto }) cliente!: ClienteResponseDto;
  @ApiProperty({ type: [LinhaServicoResponseDto] })
  servicos!: LinhaServicoResponseDto[];
  @ApiProperty({ type: [LinhaItemResponseDto] })
  itens!: LinhaItemResponseDto[];
  @ApiProperty({ example: 120 }) valorServicos!: number;
  @ApiProperty({ example: 30 }) valorPecas!: number;
  @ApiProperty({ example: 150 }) valorTotal!: number;
  @ApiProperty({ enum: ORIGENS_DECISAO, nullable: true })
  origemDecisao!: OrigemDecisao | null;
  @ApiProperty({ nullable: true, type: String }) motivoRecusa!: string | null;
  @ApiProperty({ nullable: true, type: String })
  motivoCancelamento!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Link de pagamento do Mercado Pago; existe depois da aprovação',
  })
  linkPagamento!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  linkExpiraEm!: Date | null;
  @ApiProperty({ description: 'Fluxo da OS (correlationId)' })
  correlationId!: string;
  @ApiProperty({ format: 'date-time' }) criadoEm!: Date;
  @ApiProperty({ format: 'date-time' }) atualizadoEm!: Date;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  decididoEm!: Date | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  pagoEm!: Date | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  canceladoEm!: Date | null;
}

export class PagamentoResponseDto {
  @ApiProperty({ description: 'Id do pagamento no Mercado Pago' }) id!: string;
  @ApiProperty({ format: 'uuid' }) orcamentoId!: string;
  @ApiProperty() osId!: string;
  @ApiProperty({ enum: STATUS_PAGAMENTO }) status!: StatusPagamento;
  @ApiProperty({ example: 150 }) valor!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'status_detail do Mercado Pago',
    example: 'accredited',
  })
  detalhe!: string | null;
  @ApiProperty({ format: 'date-time' }) registradoEm!: Date;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  pagoEm!: Date | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  estornadoEm!: Date | null;
  @ApiProperty({ nullable: true, type: String }) motivoEstorno!: string | null;
}

export class NotificacaoMercadoPagoResponseDto {
  @ApiProperty({
    description: 'O que foi feito com o aviso',
    enum: [
      'PAGAMENTO_CONFIRMADO',
      'PAGAMENTO_RECUSADO',
      'PAGAMENTO_ESTORNADO',
      'JA_PROCESSADO',
      'IGNORADO',
    ],
  })
  resultado!: string;
}
