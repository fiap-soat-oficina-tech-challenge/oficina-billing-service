import { randomUUID } from 'node:crypto';

/** Formato comum de toda mensagem entre os serviços (docs/contratos.md, seção 3). */
export interface Envelope<T = Record<string, unknown>> {
  messageId: string;
  correlationId: string;
  osId: string;
  tipo: string;
  ocorridoEm: string;
  payload: T;
}

export class EnvelopeInvalidoError extends Error {
  constructor(motivo: string) {
    super(`Mensagem fora do formato do envelope: ${motivo}`);
    this.name = 'EnvelopeInvalidoError';
  }
}

export function criarEnvelope<T>(
  tipo: string,
  osId: string,
  correlationId: string,
  payload: T,
  agora: Date = new Date(),
): Envelope<T> {
  return {
    messageId: randomUUID(),
    correlationId,
    osId,
    tipo,
    ocorridoEm: agora.toISOString(),
    payload,
  };
}

const CAMPOS_TEXTO = [
  'messageId',
  'correlationId',
  'osId',
  'tipo',
  'ocorridoEm',
] as const;

/** Lê e valida o corpo de uma mensagem SQS. */
export function lerEnvelope(corpo: string | undefined): Envelope {
  let dado: unknown;
  try {
    dado = JSON.parse(corpo ?? '');
  } catch {
    throw new EnvelopeInvalidoError('corpo não é JSON');
  }

  if (typeof dado !== 'object' || dado === null) {
    throw new EnvelopeInvalidoError('corpo não é um objeto');
  }

  const registro = dado as Record<string, unknown>;
  for (const campo of CAMPOS_TEXTO) {
    if (typeof registro[campo] !== 'string' || registro[campo] === '') {
      throw new EnvelopeInvalidoError(`campo ${campo} ausente`);
    }
  }
  if (typeof registro.payload !== 'object' || registro.payload === null) {
    throw new EnvelopeInvalidoError('campo payload ausente');
  }

  return registro as unknown as Envelope;
}
