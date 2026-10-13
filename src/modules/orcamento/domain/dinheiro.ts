/**
 * Valores em reais com duas casas, como no contrato e no banco
 * (`Decimal(10, 2)`). As contas são feitas em centavos inteiros, porque somar
 * números de ponto flutuante dá resultados como 0,1 + 0,2 = 0,30000000000000004.
 */
export function emCentavos(reais: number): number {
  return Math.round(reais * 100);
}

export function emReais(centavos: number): number {
  return centavos / 100;
}

/** Soma valores em reais sem erro de arredondamento. */
export function somar(valores: number[]): number {
  return emReais(valores.reduce((total, v) => total + emCentavos(v), 0));
}

/** Preço unitário vezes a quantidade, em reais. */
export function multiplicar(precoUnitario: number, quantidade: number): number {
  return emReais(emCentavos(precoUnitario) * quantidade);
}

export function iguais(a: number, b: number): boolean {
  return emCentavos(a) === emCentavos(b);
}
