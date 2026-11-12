import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const prisma = { $queryRaw: jest.fn() };
  const controller = new HealthController(prisma as unknown as PrismaService);
  let logError: jest.SpyInstance;

  beforeEach(() => {
    prisma.$queryRaw.mockReset();
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  it('liveness responde ok sem consultar o banco', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('readiness responde ok quando o banco responde', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      database: 'up',
    });
  });

  it('readiness responde 503 genérico quando o banco não responde', async () => {
    prisma.$queryRaw.mockRejectedValue(
      new Error('password authentication failed'),
    );

    const erro = await controller.ready().catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ServiceUnavailableException);
    const corpo = (erro as ServiceUnavailableException).getResponse();
    expect(corpo).toEqual({ status: 'error', database: 'down' });
    expect(JSON.stringify(corpo)).not.toContain('password');
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('password authentication failed'),
    );
  });
});
