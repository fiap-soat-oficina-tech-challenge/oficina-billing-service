import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('liveness responde ok', () => {
    expect(new HealthController().live()).toEqual({ status: 'ok' });
  });
});
