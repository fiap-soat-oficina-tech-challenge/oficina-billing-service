import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles } from '../../../../common/decorators';
import { JwtAuthGuard } from '../../../../common/guards';
import type { AuthenticatedUser } from '../../../auth/domain/types';
import {
  FiltroPorOsQueryDto,
  OrcamentoResponseDto,
  RecusarOrcamentoDto,
} from '../../application/dto/orcamento.dto';
import { ConsultarOrcamentosUseCase } from '../../application/use-case/consultar-orcamentos.use-case';
import { DecidirOrcamentoUseCase } from '../../application/use-case/decidir-orcamento.use-case';
import { apresentarOrcamento } from '../presenter/orcamento.presenter';

type RequisicaoAutenticada = Request & { user: AuthenticatedUser };

/**
 * Consulta (funcionário ou cliente dono) e decisão do cliente sobre o
 * orçamento. A decisão do sistema externo fica em WebhookController.
 */
@ApiTags('Orçamentos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('orcamentos')
export class OrcamentoController {
  constructor(
    private readonly consultar: ConsultarOrcamentosUseCase,
    private readonly decidir: DecidirOrcamentoUseCase,
  ) {}

  @Get()
  @Roles('admin', 'cliente')
  @ApiOperation({
    summary: 'Listar os orçamentos de uma OS',
    description:
      'Uma OS tem no máximo um orçamento. O cliente só vê o próprio; para os demais, a lista vem vazia.',
  })
  @ApiOkResponse({ type: [OrcamentoResponseDto] })
  async listar(
    @Query() filtro: FiltroPorOsQueryDto,
    @Req() req: RequisicaoAutenticada,
  ): Promise<OrcamentoResponseDto[]> {
    const orcamentos = await this.consultar.listarDaOs(filtro.osId, req.user);
    return Promise.all(orcamentos.map(apresentarOrcamento));
  }

  @Get(':id')
  @Roles('admin', 'cliente')
  @ApiOperation({
    summary: 'Consultar um orçamento',
    description: 'Depois da aprovação, inclui o QR Code de pagamento.',
  })
  @ApiOkResponse({ type: OrcamentoResponseDto })
  @ApiResponse({ status: 404, description: 'Orçamento não encontrado' })
  async buscar(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequisicaoAutenticada,
  ): Promise<OrcamentoResponseDto> {
    return apresentarOrcamento(await this.consultar.buscar(id, req.user));
  }

  @Post(':id/aprovar')
  @Roles('cliente')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aprovar o orçamento (cliente)',
    description:
      'Cria a cobrança no Mercado Pago, devolve o QR Code na resposta (qrCode) e o envia por e-mail. ' +
      'Avisa o orquestrador (OrcamentoAprovado) e a OS passa para AGUARDANDO_PAGAMENTO.',
  })
  @ApiOkResponse({ type: OrcamentoResponseDto })
  @ApiResponse({ status: 404, description: 'Orçamento não encontrado' })
  @ApiResponse({
    status: 409,
    description: 'O orçamento não está aguardando aprovação',
  })
  @ApiResponse({
    status: 503,
    description: 'Mercado Pago indisponível; nada mudou, tente de novo',
  })
  async aprovar(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequisicaoAutenticada,
  ): Promise<OrcamentoResponseDto> {
    const orcamento = await this.decidir.peloCliente(id, req.user.id, {
      aprovado: true,
    });
    return apresentarOrcamento(orcamento);
  }

  @Post(':id/recusar')
  @Roles('cliente')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recusar o orçamento (cliente)',
    description:
      'Avisa o orquestrador (OrcamentoRecusado), que devolve o estoque e cancela a OS.',
  })
  @ApiOkResponse({ type: OrcamentoResponseDto })
  @ApiResponse({ status: 404, description: 'Orçamento não encontrado' })
  @ApiResponse({
    status: 409,
    description: 'O orçamento não está aguardando aprovação',
  })
  async recusar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecusarOrcamentoDto,
    @Req() req: RequisicaoAutenticada,
  ): Promise<OrcamentoResponseDto> {
    const orcamento = await this.decidir.peloCliente(id, req.user.id, {
      aprovado: false,
      motivo: dto.motivo ?? null,
    });
    return apresentarOrcamento(orcamento);
  }
}
