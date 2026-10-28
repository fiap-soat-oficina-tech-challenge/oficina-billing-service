import { toBuffer } from 'qrcode';

/**
 * Imagem PNG do QR Code de pagamento, a partir do conteúdo que o Mercado Pago
 * devolve (`qr_data`, padrão EMVCo). Usada na resposta da API e no e-mail.
 *
 * Correção de erro "M" (recupera ~15% do código), o padrão para QR em tela, e
 * 300 px com margem de 2 módulos: lido sem esforço pela câmera do celular.
 */
export function gerarImagemQrCode(conteudo: string): Promise<Buffer> {
  return toBuffer(conteudo, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 300,
  });
}
