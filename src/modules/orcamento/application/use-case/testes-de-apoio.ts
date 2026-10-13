import {
  criarEnvelope,
  type Envelope,
} from '../../../../common/mensageria/envelope';
import type {
  Cobranca,
  Orcamento,
  StatusOrcamento,
} from '../../domain/orcamento';
import type { Pagamento } from '../../domain/pagamento';
import type {
  MudancasOrcamento,
  OrcamentoRepository,
} from '../../domain/repository/orcamento.repository';
import type { PagamentoRepository } from '../../domain/repository/pagamento.repository';
import type {
  RepositoriosDaTransacao,
  Transacao,
} from '../../domain/repository/transacao';
import type {
  GatewayPagamento,
  PagamentoNoGateway,
} from '../ports/gateway-pagamento';
import type { Notificador } from '../ports/notificador';
import type { PublicadorRespostas } from '../ports/publicador-respostas';

/**
 * Dublês em memória das portas, com o mesmo comportamento das implementações
 * reais: gravação condicional pelo status, chave única por OS e por pagamento,
 * e rollback quando o trabalho da transação lança erro.
 */

export class OrcamentosEmMemoria implements OrcamentoRepository {
  orcamentos = new Map<string, Orcamento>();

  criar(orcamento: Orcamento): Promise<void> {
    const repetido = [...this.orcamentos.values()].some(
      (o) => o.osId === orcamento.osId || o.codigoOS === orcamento.codigoOS,
    );
    if (repetido) return Promise.reject(new Error('unique constraint'));
    this.orcamentos.set(orcamento.id, structuredClone(orcamento));
    return Promise.resolve();
  }

  buscarPorId(id: string): Promise<Orcamento | null> {
    return Promise.resolve(this.copia((o) => o.id === id));
  }

  buscarPorOs(osId: string): Promise<Orcamento | null> {
    return Promise.resolve(this.copia((o) => o.osId === osId));
  }

  buscarPorCodigoOS(codigoOS: string): Promise<Orcamento | null> {
    return Promise.resolve(this.copia((o) => o.codigoOS === codigoOS));
  }

  atualizar(
    id: string,
    statusAtual: StatusOrcamento,
    mudancas: MudancasOrcamento,
  ): Promise<boolean> {
    const atual = this.orcamentos.get(id);
    if (!atual || atual.status !== statusAtual) return Promise.resolve(false);
    this.orcamentos.set(id, { ...atual, ...structuredClone(mudancas) });
    return Promise.resolve(true);
  }

  private copia(criterio: (o: Orcamento) => boolean): Orcamento | null {
    const achado = [...this.orcamentos.values()].find(criterio);
    return achado ? structuredClone(achado) : null;
  }
}

export class PagamentosEmMemoria implements PagamentoRepository {
  pagamentos = new Map<string, Pagamento>();

  registrar(pagamento: Pagamento): Promise<void> {
    if (this.pagamentos.has(pagamento.id)) {
      return Promise.reject(new Error('unique constraint'));
    }
    this.pagamentos.set(pagamento.id, structuredClone(pagamento));
    return Promise.resolve();
  }

  buscarPorId(id: string): Promise<Pagamento | null> {
    const achado = this.pagamentos.get(id);
    return Promise.resolve(achado ? structuredClone(achado) : null);
  }

  listarPorOs(osId: string): Promise<Pagamento[]> {
    return Promise.resolve(
      [...this.pagamentos.values()]
        .filter((p) => p.osId === osId)
        .sort((a, b) => a.registradoEm.getTime() - b.registradoEm.getTime())
        .map((p) => structuredClone(p)),
    );
  }

  buscarAprovadoDaOs(osId: string): Promise<Pagamento | null> {
    const achado = [...this.pagamentos.values()].find(
      (p) => p.osId === osId && p.status === 'APROVADO',
    );
    return Promise.resolve(achado ? structuredClone(achado) : null);
  }

  marcarEstornado(
    id: string,
    estornadoEm: Date,
    motivoEstorno: string,
  ): Promise<boolean> {
    const atual = this.pagamentos.get(id);
    if (!atual || atual.status !== 'APROVADO') return Promise.resolve(false);
    this.pagamentos.set(id, {
      ...atual,
      status: 'ESTORNADO',
      estornadoEm,
      motivoEstorno,
    });
    return Promise.resolve(true);
  }
}

/** Desfaz as gravações quando o trabalho lança erro, como o banco faria. */
export class TransacaoEmMemoria implements Transacao {
  constructor(
    private readonly orcamentos: OrcamentosEmMemoria,
    private readonly pagamentos: PagamentosEmMemoria,
  ) {}

  async executar<T>(
    trabalho: (repositorios: RepositoriosDaTransacao) => Promise<T>,
  ): Promise<T> {
    const antes = {
      orcamentos: structuredClone(this.orcamentos.orcamentos),
      pagamentos: structuredClone(this.pagamentos.pagamentos),
    };
    try {
      return await trabalho({
        orcamentos: this.orcamentos,
        pagamentos: this.pagamentos,
      });
    } catch (erro) {
      this.orcamentos.orcamentos = antes.orcamentos;
      this.pagamentos.pagamentos = antes.pagamentos;
      throw erro;
    }
  }
}

export class PublicadorEmMemoria implements PublicadorRespostas {
  readonly publicadas: Envelope<unknown>[] = [];
  falhar = false;

  publicar(envelope: Envelope<unknown>): Promise<void> {
    if (this.falhar) return Promise.reject(new Error('SQS fora'));
    this.publicadas.push(envelope);
    return Promise.resolve();
  }

  tipos(): string[] {
    return this.publicadas.map((e) => e.tipo);
  }
}

export class GatewayFalso implements GatewayPagamento {
  readonly chamadas: string[] = [];
  pagamentos = new Map<string, PagamentoNoGateway>();
  falha?: Error;

  criarCobranca(orcamento: Orcamento, expiraEm: Date): Promise<Cobranca> {
    return this.registrar(`criarCobranca:${orcamento.id}`, {
      preferenciaId: `pref-${orcamento.id}`,
      linkPagamento: `https://sandbox.mercadopago.com.br/checkout/${orcamento.id}`,
      expiraEm,
    });
  }

  expirarCobranca(preferenciaId: string): Promise<void> {
    return this.registrar(`expirarCobranca:${preferenciaId}`, undefined);
  }

  consultarPagamento(pagamentoId: string): Promise<PagamentoNoGateway | null> {
    return this.registrar(
      `consultarPagamento:${pagamentoId}`,
      this.pagamentos.get(pagamentoId) ?? null,
    );
  }

  estornar(pagamentoId: string): Promise<{ estornadoEm: Date }> {
    return this.registrar(`estornar:${pagamentoId}`, {
      estornadoEm: new Date('2026-10-20T15:00:00.000Z'),
    });
  }

  private registrar<T>(chamada: string, resultado: T): Promise<T> {
    this.chamadas.push(chamada);
    return this.falha ? Promise.reject(this.falha) : Promise.resolve(resultado);
  }
}

export class NotificadorEmMemoria implements Notificador {
  readonly enviados: string[] = [];

  enviarOrcamento(orcamento: Orcamento): Promise<void> {
    this.enviados.push(`orcamento:${orcamento.id}`);
    return Promise.resolve();
  }

  enviarLinkPagamento(orcamento: Orcamento): Promise<void> {
    this.enviados.push(`link:${orcamento.id}`);
    return Promise.resolve();
  }
}

/** Monta todos os dublês ligados entre si. */
export function criarCenario() {
  const orcamentos = new OrcamentosEmMemoria();
  const pagamentos = new PagamentosEmMemoria();
  return {
    orcamentos,
    pagamentos,
    transacao: new TransacaoEmMemoria(orcamentos, pagamentos),
    publicador: new PublicadorEmMemoria(),
    gateway: new GatewayFalso(),
    notificador: new NotificadorEmMemoria(),
  };
}

export const OS_ID = 'c56f9df1-b6f7-4625-84ce-a27706664ae5';
export const ORCAMENTO_ID = '5b1d0e6a-3f0c-4f7e-9a8b-1c2d3e4f5a6b';
export const CLIENTE_ID = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a';
export const AGORA = new Date('2026-10-20T14:00:00.000Z');

/** Payload válido do comando GerarOrcamento (docs/contratos.md). */
export function payloadGerarOrcamento(): Record<string, unknown> {
  return {
    codigo: 'OS-2026-000001',
    cliente: { id: CLIENTE_ID, nome: 'Maria Silva', email: 'maria@email.com' },
    servicos: [
      {
        servicoId: 'srv-1',
        nome: 'Troca de óleo',
        precoUnitario: 120,
        quantidade: 1,
        subtotal: 120,
      },
    ],
    itens: [
      {
        itemEstoqueId: 'item-1',
        nome: 'Filtro de óleo',
        precoUnitario: 15.1,
        quantidade: 2,
        subtotal: 30.2,
      },
    ],
    valorServicos: 120,
    valorPecas: 30.2,
    valorTotal: 150.2,
  };
}

export function envelopeDeComando(
  tipo: string,
  payload: Record<string, unknown>,
): Envelope {
  return criarEnvelope(tipo, OS_ID, 'fluxo-da-os', payload, AGORA);
}

export function orcamentoDeExemplo(
  sobrescrever: Partial<Orcamento> = {},
): Orcamento {
  return {
    id: ORCAMENTO_ID,
    osId: OS_ID,
    codigoOS: 'OS-2026-000001',
    correlationId: 'fluxo-da-os',
    cliente: { id: CLIENTE_ID, nome: 'Maria Silva', email: 'maria@email.com' },
    servicos: [
      {
        referenciaId: 'srv-1',
        nome: 'Troca de óleo',
        precoUnitario: 120,
        quantidade: 1,
        subtotal: 120,
      },
    ],
    itens: [],
    valorServicos: 120,
    valorPecas: 0,
    valorTotal: 120,
    status: 'AGUARDANDO_APROVACAO',
    origemDecisao: null,
    motivoRecusa: null,
    motivoCancelamento: null,
    cobranca: null,
    criadoEm: AGORA,
    atualizadoEm: AGORA,
    decididoEm: null,
    pagoEm: null,
    canceladoEm: null,
    ...sobrescrever,
  };
}

export const COBRANCA: Cobranca = {
  preferenciaId: 'pref-1',
  linkPagamento: 'https://sandbox.mercadopago.com.br/checkout/pref-1',
  expiraEm: new Date('2026-10-23T14:00:00.000Z'),
};

export function pagamentoDeExemplo(
  sobrescrever: Partial<Pagamento> = {},
): Pagamento {
  return {
    id: '1234567890',
    orcamentoId: ORCAMENTO_ID,
    osId: OS_ID,
    status: 'APROVADO',
    valor: 120,
    detalhe: 'accredited',
    registradoEm: AGORA,
    pagoEm: AGORA,
    estornadoEm: null,
    motivoEstorno: null,
    ...sobrescrever,
  };
}

export function pagamentoNoGateway(
  sobrescrever: Partial<PagamentoNoGateway> = {},
): PagamentoNoGateway {
  return {
    id: '1234567890',
    situacao: 'APROVADO',
    statusOriginal: 'approved',
    detalhe: 'accredited',
    orcamentoId: ORCAMENTO_ID,
    valor: 120,
    pagoEm: new Date('2026-10-20T14:30:00.000Z'),
    ...sobrescrever,
  };
}
