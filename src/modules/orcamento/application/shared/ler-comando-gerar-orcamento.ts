import { iguais, multiplicar, somar } from '../../domain/dinheiro';
import type {
  ClienteDoOrcamento,
  LinhaOrcamento,
} from '../../domain/orcamento';

/** Os dados do comando GerarOrcamento, já conferidos. */
export interface DadosDoOrcamento {
  codigo: string;
  cliente: ClienteDoOrcamento;
  servicos: LinhaOrcamento[];
  itens: LinhaOrcamento[];
  valorServicos: number;
  valorPecas: number;
  valorTotal: number;
}

/** Por que o comando não vira orçamento: vai no `motivo` de GeracaoOrcamentoFalhou. */
export interface ProblemaNoComando {
  motivo: string;
}

/** A OS não tem nenhum serviço nem item: não há o que orçar. */
export const ORCAMENTO_VAZIO = 'ORCAMENTO_VAZIO';

function invalido(detalhe: string): ProblemaNoComando {
  return { motivo: `COMANDO_INVALIDO: ${detalhe}` };
}

function texto(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.trim() !== '';
}

function valorEmReais(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isFinite(valor) && valor >= 0;
}

/**
 * Confere uma lista de linhas (serviços ou itens). `campoId` é o nome do id da
 * linha no OS Service: `servicoId` ou `itemEstoqueId`.
 */
function lerLinhas(
  valor: unknown,
  campo: string,
  campoId: string,
): LinhaOrcamento[] | ProblemaNoComando {
  if (valor === undefined) return [];
  if (!Array.isArray(valor)) return invalido(`${campo} deve ser uma lista`);

  const linhas: LinhaOrcamento[] = [];
  for (const bruto of valor as unknown[]) {
    const linha = bruto as Record<string, unknown> | null;
    if (
      typeof linha !== 'object' ||
      linha === null ||
      !texto(linha[campoId]) ||
      !texto(linha.nome) ||
      !valorEmReais(linha.precoUnitario) ||
      !Number.isInteger(linha.quantidade) ||
      (linha.quantidade as number) <= 0 ||
      !valorEmReais(linha.subtotal)
    ) {
      return invalido(
        `${campo} precisa de ${campoId}, nome, precoUnitario, quantidade inteira positiva e subtotal`,
      );
    }
    if (
      !iguais(
        linha.subtotal,
        multiplicar(linha.precoUnitario, linha.quantidade as number),
      )
    ) {
      return invalido(
        `subtotal de "${linha.nome}" não é precoUnitario × quantidade`,
      );
    }
    linhas.push({
      referenciaId: linha[campoId],
      nome: linha.nome,
      precoUnitario: linha.precoUnitario,
      quantidade: linha.quantidade as number,
      subtotal: linha.subtotal,
    });
  }
  return linhas;
}

function lerCliente(valor: unknown): ClienteDoOrcamento | ProblemaNoComando {
  const cliente = valor as Record<string, unknown> | null | undefined;
  if (
    typeof cliente !== 'object' ||
    cliente === null ||
    !texto(cliente.id) ||
    !texto(cliente.nome)
  ) {
    return invalido('cliente precisa de id e nome');
  }
  return {
    id: cliente.id,
    nome: cliente.nome,
    email: texto(cliente.email) ? cliente.email : null,
  };
}

/**
 * Lê o payload de GerarOrcamento (docs/contratos.md, seção 5) e confere as
 * contas: cada subtotal é preço × quantidade, e os totais são a soma das
 * linhas. Um orçamento com valor que não fecha não chega ao cliente.
 *
 * Devolve os dados do orçamento ou o problema encontrado.
 */
export function lerComandoGerarOrcamento(
  payload: Record<string, unknown>,
): DadosDoOrcamento | ProblemaNoComando {
  if (!texto(payload.codigo)) return invalido('codigo ausente');

  const cliente = lerCliente(payload.cliente);
  if ('motivo' in cliente) return cliente;

  const servicos = lerLinhas(payload.servicos, 'servicos', 'servicoId');
  if ('motivo' in servicos) return servicos;
  const itens = lerLinhas(payload.itens, 'itens', 'itemEstoqueId');
  if ('motivo' in itens) return itens;

  if (servicos.length + itens.length === 0) return { motivo: ORCAMENTO_VAZIO };

  const { valorServicos, valorPecas, valorTotal } = payload;
  if (
    !valorEmReais(valorServicos) ||
    !valorEmReais(valorPecas) ||
    !valorEmReais(valorTotal)
  ) {
    return invalido('valorServicos, valorPecas e valorTotal são obrigatórios');
  }
  if (
    !iguais(valorServicos, somar(servicos.map((l) => l.subtotal))) ||
    !iguais(valorPecas, somar(itens.map((l) => l.subtotal))) ||
    !iguais(valorTotal, somar([valorServicos, valorPecas]))
  ) {
    return invalido('os totais não conferem com a soma das linhas');
  }

  return {
    codigo: payload.codigo,
    cliente,
    servicos,
    itens,
    valorServicos,
    valorPecas,
    valorTotal,
  };
}
