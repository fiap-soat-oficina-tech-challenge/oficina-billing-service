import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

/**
 * Liveness: responde enquanto o processo estiver no ar. Usado pelas sondas do
 * Kubernetes e pelo health check do ALB. A checagem de dependências (banco,
 * filas) entra na readiness quando o serviço passar a ter dependências.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness — processo no ar' })
  live() {
    return { status: 'ok' };
  }
}
