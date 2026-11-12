import type {
  OrcamentoResponseDto,
  QrCodeResponseDto,
} from '../../application/dto/orcamento.dto';
import type { Cobranca, Orcamento } from '../../domain/orcamento';
import { gerarImagemQrCode } from '../../infra/qr-code/imagem-qr-code';

/**
 * Formato do orçamento nas respostas da API. As linhas voltam com o nome do id
 * usado no OS Service (`servicoId`, `itemEstoqueId`), como no comando
 * GerarOrcamento, e o QR Code de pagamento fica no primeiro nível.
 */
export async function apresentarOrcamento(
  orcamento: Orcamento,
): Promise<OrcamentoResponseDto> {
  const { servicos, itens, cobranca, ...resto } = orcamento;
  return {
    ...resto,
    servicos: servicos.map(({ referenciaId, ...linha }) => ({
      servicoId: referenciaId,
      ...linha,
    })),
    itens: itens.map(({ referenciaId, ...linha }) => ({
      itemEstoqueId: referenciaId,
      ...linha,
    })),
    qrCode: cobranca ? await apresentarQrCode(cobranca) : null,
  };
}

async function apresentarQrCode(
  cobranca: Cobranca,
): Promise<QrCodeResponseDto> {
  const imagem = await gerarImagemQrCode(cobranca.qrCode);
  return {
    conteudo: cobranca.qrCode,
    imagem: `data:image/png;base64,${imagem.toString('base64')}`,
    expiraEm: cobranca.expiraEm,
  };
}
