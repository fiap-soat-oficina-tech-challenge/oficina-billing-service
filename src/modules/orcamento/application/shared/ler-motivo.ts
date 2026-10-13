/** Motivo usado quando o comando de compensação chega sem um. */
export const MOTIVO_NAO_INFORMADO = 'NAO_INFORMADO';

/**
 * Lê o `motivo` de um comando de compensação. A falta dele não recusa o
 * comando: uma compensação nunca deve se perder por um campo descritivo.
 */
export function lerMotivo(payload: Record<string, unknown>): string {
  const { motivo } = payload;
  return typeof motivo === 'string' && motivo.trim() !== ''
    ? motivo
    : MOTIVO_NAO_INFORMADO;
}
