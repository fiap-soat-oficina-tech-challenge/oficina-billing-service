import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../../common/guards';
import {
  FiltroPorOsQueryDto,
  PagamentoResponseDto,
} from '../../application/dto/orcamento.dto';
import { ConsultarOrcamentosUseCase } from '../../application/use-case/consultar-orcamentos.use-case';
import type { Pagamento } from '../../domain/pagamento';

/** Consulta de pagamentos e estornos (funcionário). */
@ApiTags('Pagamentos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('pagamentos')
export class PagamentoController {
  constructor(private readonly consultar: ConsultarOrcamentosUseCase) {}

  @Get()
  @ApiOperation({
    summary: 'Pagamentos e estornos de uma OS',
    description:
      'Inclui tentativas recusadas e pagamentos estornados, mais antigos primeiro.',
  })
  @ApiOkResponse({ type: [PagamentoResponseDto] })
  listar(@Query() filtro: FiltroPorOsQueryDto): Promise<Pagamento[]> {
    return this.consultar.listarPagamentosDaOs(filtro.osId);
  }
}
