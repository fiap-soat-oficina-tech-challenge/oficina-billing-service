# Billing Service

Orçamentos, aprovação e pagamentos com o Mercado Pago.

Microsserviço do Tech Challenge da Fase 4 (FIAP SOAT). A oficina mecânica foi dividida em três serviços: OS Service, Billing Service e Execution Service. A Saga é orquestrada pelo OS Service. Os contratos de mensagens e rotas entre os serviços estão em [docs/contratos.md](https://github.com/LucasValada/tech-challenge-fiap/blob/develop/docs/contratos.md), e este serviço segue esse documento à risca.

| Serviço | Repositório | Banco |
|---|---|---|
| OS Service (orquestrador da Saga) | [LucasValada/tech-challenge-fiap](https://github.com/LucasValada/tech-challenge-fiap) | PostgreSQL |
| Billing Service | [oficina-billing-service](https://github.com/fiap-soat-oficina-tech-challenge/oficina-billing-service) | PostgreSQL |
| Execution Service | [oficina-execution-service](https://github.com/fiap-soat-oficina-tech-challenge/oficina-execution-service) | DynamoDB |

## Sumário

- [Responsabilidades](#responsabilidades)
- [Como funciona](#como-funciona)
- [Ciclo do orçamento e do pagamento](#ciclo-do-orçamento-e-do-pagamento)
- [Fluxos da Saga](#fluxos-da-saga)
- [Mensagens](#mensagens)
- [API REST](#api-rest)
- [Integração com o Mercado Pago](#integração-com-o-mercado-pago)
- [Garantias](#garantias)
- [Modelo de dados](#modelo-de-dados)
- [Arquitetura do código](#arquitetura-do-código)
- [Tecnologias](#tecnologias)
- [Rodando localmente](#rodando-localmente)
- [Testes e cobertura](#testes-e-cobertura)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Deploy](#deploy)
- [Fluxo de trabalho](#fluxo-de-trabalho)
- [Decisões e limites](#decisões-e-limites)

## Responsabilidades

- Gerar o orçamento da OS e enviá-lo ao cliente para aprovação
- Registrar a aprovação ou a recusa, feita pelo cliente ou pelo sistema externo
- Cobrar pelo Mercado Pago (QR Code dinâmico), confirmar os pagamentos e estornar quando a Saga precisa compensar
- Avisar a Saga de cada resultado: orçamento enviado, aprovado ou recusado, e pagamento confirmado ou estornado

O serviço **não** muda o status da OS. Ele só avisa o OS Service, e o orquestrador decide.

## Como funciona

```mermaid
flowchart LR
    OS["OS Service<br/>(orquestrador da Saga)"]
    CMD[["SQS<br/>oficina-billing-commands"]]
    RESP[["SQS<br/>oficina-os-saga-replies"]]
    BI["Billing Service"]
    DB[("PostgreSQL<br/>oficina-billing-db")]
    MP["Mercado Pago<br/>(QR Code dinâmico)"]
    MAIL["Lambda /mail"]
    CLI["Cliente<br/>(JWT do CPF)"]
    EXT["Sistema externo<br/>(x-webhook-token)"]
    FUNC["Funcionário<br/>(JWT)"]

    OS -->|"GerarOrcamento<br/>CancelarOrcamento<br/>EstornarPagamento"| CMD
    CMD -->|consome| BI
    BI -->|"orçamentos e pagamentos"| DB
    CLI -->|"aprovar · recusar · consultar"| BI
    EXT -->|"POST /billing/webhooks/orcamento"| BI
    FUNC -->|"consultar orçamentos e pagamentos"| BI
    BI -->|"cria a cobrança · consulta · cancela · estorna"| MP
    MP -->|"aviso da order (webhook)"| BI
    BI -->|"orçamento e QR Code de pagamento"| MAIL
    BI -->|"OrcamentoEnviado · OrcamentoAprovado · OrcamentoRecusado<br/>PagamentoConfirmado · PagamentoEstornado<br/>GeracaoOrcamentoFalhou"| RESP
    RESP --> OS
```

1. Quando o mecânico conclui o diagnóstico, o OS Service publica `GerarOrcamento` com uma cópia das linhas da OS (serviços e itens, com os preços daquele momento). O Billing cria o orçamento, responde `OrcamentoEnviado` e manda o orçamento por e-mail ao cliente.
2. O cliente aprova ou recusa pela API, com o token do CPF. O sistema externo também pode decidir, pelo webhook. Na aprovação, o Billing cria a cobrança no Mercado Pago (uma order de QR Code dinâmico), devolve o QR Code na resposta e o envia por e-mail, como imagem.
3. O cliente paga lendo o QR Code com o app do Mercado Pago. O Mercado Pago avisa o webhook do Billing, que consulta a order na API do Mercado Pago e responde `PagamentoConfirmado`. Uma recusa não encerra nada: a order continua aberta, o Mercado Pago nem avisa, e o cliente paga de novo pelo mesmo QR Code, com outro cartão ou outro meio. A OS só avança quando um pagamento é confirmado.
4. Se a Saga precisar desfazer, o OS Service manda `CancelarOrcamento` (o funcionário cancelou a OS antes do pagamento) ou `EstornarPagamento` (o reparo falhou depois do pagamento).

## Ciclo do orçamento e do pagamento

```mermaid
stateDiagram-v2
    [*] --> AGUARDANDO_APROVACAO: GerarOrcamento
    AGUARDANDO_APROVACAO --> APROVADO: aprovar (cria a cobrança)
    AGUARDANDO_APROVACAO --> RECUSADO: recusar
    APROVADO --> PAGO: pagamento aprovado
    AGUARDANDO_APROVACAO --> CANCELADO: CancelarOrcamento
    APROVADO --> CANCELADO: CancelarOrcamento (cancela a cobrança)
    PAGO --> CANCELADO: CancelarOrcamento ou EstornarPagamento (estorna)
    RECUSADO --> [*]
    CANCELADO --> [*]
```

As transições ficam em [`domain/orcamento.ts`](src/modules/orcamento/domain/orcamento.ts). Ação fora do ciclo, como aprovar um orçamento já recusado, responde 409 e não publica nada.

Cada cobrança paga vira um registro de pagamento, identificado pelo id da order no Mercado Pago (`ORD...`). Tentativas recusadas não viram registro: o Mercado Pago não as avisa, e a order continua aberta.

| Status | Quando |
|---|---|
| `APROVADO` | pagamento que quitou o orçamento |
| `ESTORNADO` | devolvido ao cliente, seja por compensação da Saga, seja porque chegou depois do cancelamento |

## Fluxos da Saga

Caminho feliz, do ponto de vista do Billing:

```mermaid
sequenceDiagram
    participant OS as OS Service
    participant BI as Billing
    participant CL as Cliente
    participant MP as Mercado Pago

    OS->>BI: GerarOrcamento (fila)
    BI-->>OS: OrcamentoEnviado
    BI-->>CL: e-mail com o orçamento
    CL->>BI: POST /billing/orcamentos/{id}/aprovar
    BI->>MP: POST /v1/orders (QR Code dinâmico)
    MP-->>BI: order com o QR Code
    BI-->>OS: OrcamentoAprovado
    BI-->>CL: QR Code (resposta e e-mail)
    CL->>MP: paga lendo o QR Code no app
    MP->>BI: aviso (webhook, tópico order)
    BI->>MP: GET /v1/orders/{id}
    BI-->>OS: PagamentoConfirmado
```

O que o Billing faz em cada falha. A coluna **Compensação** é o que acontece aqui; a compensação no OS (devolver estoque e cancelar a OS) está em `docs/contratos.md`.

| Situação | Quem detecta | O Billing faz | Responde |
|---|---|---|---|
| OS sem serviços nem itens | Billing, no `GerarOrcamento` | não cria o orçamento | `GeracaoOrcamentoFalhou` (`ORCAMENTO_VAZIO`) |
| Comando com dados inválidos ou totais que não fecham | Billing, no `GerarOrcamento` | não cria o orçamento | `GeracaoOrcamentoFalhou` (`COMANDO_INVALIDO: ...`) |
| Cliente ou sistema externo recusa | Billing | marca `RECUSADO` | `OrcamentoRecusado` |
| Mercado Pago fora na aprovação | Billing | nada muda; a rota responde 503 | — |
| Pagamento recusado | Mercado Pago (no app) | nada: o Mercado Pago não avisa, a order continua aberta e o cliente paga de novo pelo mesmo QR Code | — (a OS continua aguardando pagamento) |
| Funcionário cancela a OS esperando o cliente (desistência, QR Code expirado) | OS (`CancelarOrcamento`) | cancela; se já havia cobrança, **cancela a order**; se já estava pago, **estorna** | `PagamentoEstornado`, só se estornou |
| Reparo falhou depois do pagamento | OS (`EstornarPagamento`) | **estorna** e cancela o orçamento | `PagamentoEstornado` |
| Pagamento aprovado depois do cancelamento | Mercado Pago | **estorna** | `PagamentoEstornado` |

Nenhuma OS cancelada fica com dinheiro retido: o pagamento é estornado pelo caminho que chegar primeiro.

## Mensagens

Formato do envelope e payloads em `docs/contratos.md`, seções 3 e 5.

**Consome** (fila `oficina-billing-commands`):

| Comando | Caso de uso |
|---|---|
| `GerarOrcamento` | [`gerar-orcamento.use-case.ts`](src/modules/orcamento/application/use-case/gerar-orcamento.use-case.ts) |
| `CancelarOrcamento` | [`cancelar-orcamento.use-case.ts`](src/modules/orcamento/application/use-case/cancelar-orcamento.use-case.ts) |
| `EstornarPagamento` | [`estornar-pagamento.use-case.ts`](src/modules/orcamento/application/use-case/estornar-pagamento.use-case.ts) |

Um tipo desconhecido é descartado com um log de aviso.

**Publica** (fila `oficina-os-saga-replies`). Toda resposta leva o `osId` e o `correlationId` do fluxo da OS, que ficam guardados no orçamento:

| Resposta | Quando | `payload` |
|---|---|---|
| `OrcamentoEnviado` | orçamento criado | `{ orcamentoId, valorTotal }` |
| `GeracaoOrcamentoFalhou` | comando sem linhas ou inválido | `{ motivo }` |
| `OrcamentoAprovado` | aprovação do cliente ou do sistema externo | `{ orcamentoId, origem }` |
| `OrcamentoRecusado` | recusa | `{ orcamentoId, origem, motivo }` |
| `PagamentoConfirmado` | order paga no Mercado Pago | `{ pagamentoId, valor, pagoEm }` (`pagamentoId` é o id da order) |
| `PagamentoEstornado` | estorno feito | `{ pagamentoId, estornadoEm }` |

## API REST

Prefixo `/billing`. A documentação interativa (Swagger) fica em `/billing/api`.

| Método e rota | Quem chama | O que faz |
|---|---|---|
| `GET /billing/orcamentos?osId={osId}` | funcionário ou cliente dono | Lista os orçamentos da OS (no máximo um). O cliente só vê o próprio; para os outros, a lista vem vazia |
| `GET /billing/orcamentos/{id}` | funcionário ou cliente dono | Consulta um orçamento; depois da aprovação, inclui o `qrCode`: `conteudo` (EMVCo), `imagem` (PNG em data URL) e `expiraEm`. Orçamento de outro cliente é 404 |
| `POST /billing/orcamentos/{id}/aprovar` | cliente dono | Aprova, cria a cobrança no Mercado Pago e devolve o orçamento com o `qrCode`. 409 se não estiver aguardando aprovação; 503 se o Mercado Pago falhar (nada muda) |
| `POST /billing/orcamentos/{id}/recusar` | cliente dono | Recusa, com `{ motivo }` opcional |
| `POST /billing/webhooks/orcamento` | sistema externo (`x-webhook-token`) | Aprovação externa: `{ codigoOS, aprovado, motivo? }`. É o mesmo corpo do webhook do OS na Fase 3; só a URL mudou |
| `POST /billing/webhooks/mercado-pago` | Mercado Pago (rota pública) | Aviso da order (tópico `order`). Responde `{ resultado }`: `PAGAMENTO_CONFIRMADO`, `PAGAMENTO_ESTORNADO`, `JA_PROCESSADO` ou `IGNORADO` |
| `GET /billing/pagamentos?osId={osId}` | funcionário | Pagamento e estorno da OS |
| `GET /billing/health` e `/billing/health/ready` | Kubernetes e ALB | Liveness (o processo responde) e readiness (o banco responde) |

O serviço não emite token. Ele valida o mesmo JWT do OS Service (funcionário, login por e-mail) e da Lambda de autenticação (cliente, por CPF), com o segredo `JWT_SECRET`. Sem `@Roles` na rota, só o funcionário passa.

## Integração com o Mercado Pago

O produto é o **QR Code dinâmico** ([Orders API](https://www.mercadopago.com.br/developers/pt/docs/qr-code/overview)), com credenciais de teste: uma order por orçamento, com um QR Code único, pago pelo cliente no app do Mercado Pago. O adaptador está em [`infra/mercado-pago/mercado-pago.gateway.ts`](src/modules/orcamento/infra/mercado-pago/mercado-pago.gateway.ts) e usa a API REST direto, com `fetch` e sem SDK:

| Operação | Chamada | Quando |
|---|---|---|
| Criar a cobrança | `POST /v1/orders` com `type: qr`, `config.qr.mode: dynamic` no caixa `MERCADO_PAGO_CAIXA_ID`, `external_reference` = id do orçamento e prazo (`expiration_time: PT72H`); o QR Code vem em `type_response.qr_data` | na aprovação |
| Consultar | `GET /v1/orders/{id}` (`processed` = paga) | a cada aviso do webhook |
| Cancelar | `POST /v1/orders/{id}/cancel` | `CancelarOrcamento` com o orçamento aprovado |
| Estornar | `POST /v1/orders/{id}/refund`, sem corpo (estorno total) | compensações |

A imagem do QR Code (PNG) é gerada pelo próprio serviço a partir do `qr_data`, com a biblioteca `qrcode`: vai na resposta da API (data URL) e no e-mail, embutida no HTML pela Lambda `/mail`.

Como o adaptador se protege:

- **O aviso nunca é a fonte da verdade.** O webhook só traz o id da order. Situação, valor e orçamento vêm da consulta à API, então um aviso forjado não confirma pagamento nenhum. Por isso a rota pode ser pública, e a assinatura `x-signature` não é conferida.
- **Timeout e nova tentativa.** Cada chamada tem timeout de 10 s e uma nova tentativa em erro de rede, 429 ou 5xx. O pior caso (cerca de 20 s) fica abaixo dos 30 s do API Gateway e dos 60 s de visibilidade da fila. Erro 4xx não é repetido, porque repetir não resolve.
- **Idempotência em toda escrita.** O `X-Idempotency-Key` é fixo: `cobranca-{orçamento}`, `cancelamento-{order}` e `estorno-{order}`. Uma aprovação repetida devolve a mesma order, e um estorno repetido não devolve o dinheiro duas vezes. Passadas as 24 h da chave, um estorno repetido volta 409; se a order já está estornada, o adaptador trata como feito.
- **Cancelar o que já foi pago não é erro.** O Mercado Pago só cancela order aberta e responde 409 `cannot_cancel_order` para uma paga, expirada ou cancelada. O cancelamento segue, e um pagamento feito no meio chega pelo webhook e cai no estorno automático. Outro 409 (`instore_order_locked_error`, com um pagamento em andamento) volta para a fila e é repetido.
- **Order desconhecida.** O aviso simulado do painel manda um id que não existe (404, ou 400 pelo formato). É ignorado com 200, para não ser reenviado à toa.

Uma recusa não muda a order nem gera aviso; o cliente paga de novo pelo mesmo QR Code até ele expirar. Uma order que expira gera aviso (`order.expired`), mas o Billing não age sozinho: uma OS parada esperando pagamento é cancelada pelo funcionário no OS Service, e o cancelamento chega aqui como `CancelarOrcamento`.

Localmente e nos testes, a API é substituída pelo [simulador](mercado-pago-simulador/README.md) (WireMock), apontado por `MERCADO_PAGO_API_URL`. O código é o mesmo.

### Configuração da conta de teste (uma vez)

Conferido contra a API real em 28/10/2026. A documentação do Mercado Pago diverge do comportamento em três pontos, marcados abaixo.

1. **Aplicação.** Em [Suas integrações](https://www.mercadopago.com.br/developers/panel/app), criar a aplicação escolhendo a solução **QR Code**. As credenciais de teste e as contas de teste (vendedor e comprador) são criadas junto.
2. **Token.** O Access Token de teste (`APP_USR-...`, em *Credenciais de teste*) vai para o SSM, em `billing/MERCADO_PAGO_ACCESS_TOKEN`. Ele pertence ao **vendedor de teste**, e as orders são criadas por uma aplicação oculta dele (`TestApp-...`), não pela aplicação da conta pessoal.
3. **Loja e caixa.** Criados pela API com o token, no `user_id` das credenciais de teste: `POST /users/{user_id}/stores` (com `location`) e `POST /v2/pos` com `external_store_id`, `external_id` e `config.qr.operating_mode: pdv`. O `external_id` do caixa é o `MERCADO_PAGO_CAIXA_ID` (no ambiente, `OFICINA01CAIXA01`). *O guia de teste pede `fixed_amount=true` no caixa; a `/v2/pos` recusa o campo.*
4. **Webhook.** Entrar no painel **logado como o vendedor de teste** (usuário e senha em *Contas de teste* da aplicação), abrir a **TestApp**, *Webhooks → Configurar notificações*, aba **Modo de teste**: URL `<API_GATEWAY_URL>/billing/webhooks/mercado-pago`, evento **Order (Mercado Pago)**. *A documentação manda usar o Modo produção, por onde nenhum aviso chegou; e o "Simular notificação" do Modo de teste responde 200 sem chamar a URL — só um pagamento de verdade confirma a configuração.* O endereço do API Gateway muda quando a plataforma é recriada, e então o webhook precisa ser atualizado.
5. **Pagamento de teste.** App do Mercado Pago no celular, logado com o **comprador de teste**, lendo o QR Code. Cartões da conta de teste: Mastercard `5480 8328 0103 3311` e Visa `4235 4777 2802 5682` aprovam; Elo Débito `5067 7667 8388 8311` recusa (a order continua aberta). O saldo da conta também paga.

## Garantias

- **Banco próprio.** Orçamentos e pagamentos ficam no PostgreSQL deste serviço. O cliente e as linhas chegam no comando, e o serviço nunca consulta o banco do OS Service.
- **Comando repetido não duplica nada.** O SQS entrega cada mensagem pelo menos uma vez, então o serviço confere o estado e usa chaves naturais (`docs/contratos.md`, seção 1):
  - uma OS tem um só orçamento (`osId` único), então um `GerarOrcamento` repetido é ignorado;
  - um pagamento é registrado uma vez (a chave é o id da order), então um aviso repetido responde `JA_PROCESSADO`;
  - um pagamento só é estornado se ainda estiver `APROVADO`, então um `EstornarPagamento` repetido não faz nada;
  - um `CancelarOrcamento` para orçamento já `RECUSADO` ou `CANCELADO` não faz nada.
- **Gravar e publicar na mesma transação.** Quem grava e publica faz as duas coisas dentro de uma transação do banco, publicando antes do commit ([`domain/repository/transacao.ts`](src/modules/orcamento/domain/repository/transacao.ts)). Se a publicação falha, nada fica gravado. É a alternativa enxuta ao outbox transacional, definida nos contratos.
- **Chamadas externas fora da transação.** O Mercado Pago é chamado antes da transação. Assim, uma conexão do banco nunca fica presa esperando a rede, e uma falha do Mercado Pago não deixa nada pela metade.
- **Concorrência otimista.** Toda mudança de status grava com o status lido no filtro (`UPDATE ... WHERE status = <lido>`). Se outra ação chegou antes (um pagamento no meio de um cancelamento, por exemplo), a gravação não acontece. A rota responde 409, e a mensagem ou o aviso é processado de novo, já vendo o estado novo.
- **Falha de negócio vira resposta; falha técnica vira nova tentativa.** Um comando sem linhas responde `GeracaoOrcamentoFalhou`, para o orquestrador compensar. Banco ou Mercado Pago fora devolve a mensagem para a fila: depois de 5 tentativas ela vai para a DLQ `oficina-billing-commands-dlq`, então uma compensação nunca se perde.
- **E-mail é best-effort.** Falha no envio só vai para o log e nunca desfaz a operação, como na Fase 3.
- **Rastreamento.** As linhas de log do consumo de mensagens levam o `correlationId` e o `osId` do envelope, os mesmos do OS e do Execution, e é por eles que se acompanha uma OS nos três serviços no New Relic. Nas rotas HTTP, o `correlationId` da linha é o da requisição (header `x-correlation-id`), e os eventos de negócio levam o `os_id`. As respostas publicadas a partir de uma rota HTTP levam o `correlationId` do fluxo, guardado no orçamento.

## Modelo de dados

Schema em [`prisma/schema.prisma`](prisma/schema.prisma); migrations em `prisma/migrations/`.

| Tabela | Conteúdo | Chaves e índices |
|---|---|---|
| `Orcamento` | OS (id e código), `correlationId` do fluxo, cliente (cópia), totais, status, decisão (origem e motivo), cobrança (id da order, conteúdo do QR Code e prazo), datas de cada etapa | `id`; `osId` e `codigoOS` únicos; índice por `clienteId` |
| `LinhaOrcamento` | serviços e itens do orçamento (`tipo`), com nome, preço unitário, quantidade e subtotal da época, na ordem em que chegaram | índice por `orcamentoId` |
| `Pagamento` | a cobrança paga, como o Mercado Pago a informou: status, valor, `status_detail`, datas e motivo do estorno | `id` = id da order; índices por `osId` e `orcamentoId` |

**Por que PostgreSQL.** Orçamento e pagamento são dinheiro, e o serviço precisa de:

- transação de verdade: o orçamento, as linhas e a publicação da resposta se confirmam juntos;
- chaves únicas que garantem a idempotência (um orçamento por OS, um registro por pagamento);
- gravação condicional pelo status;
- valores decimais exatos.

O banco relacional dá tudo isso, e é o mesmo motor e a mesma ferramenta (Prisma) do OS Service. O NoSQL do projeto fica no Execution, onde os dados são documentos simples por chave.

Valores em `Decimal(10, 2)`, como no OS Service. No código, as contas de dinheiro são feitas em centavos inteiros ([`domain/dinheiro.ts`](src/modules/orcamento/domain/dinheiro.ts)) para evitar erro de ponto flutuante. O `GerarOrcamento` só é aceito se cada subtotal for preço × quantidade e os totais fecharem com a soma das linhas.

## Arquitetura do código

Arquitetura limpa, no mesmo padrão de módulos do OS Service (`domain`, `application`, `infra`, `interface`). Os casos de uso dependem só de **portas** (interfaces), e as implementações concretas (Prisma, SQS, Mercado Pago, Lambda de e-mail) são ligadas no módulo do Nest. Por isso os testes dos casos de uso rodam com dublês em memória, sem banco nem rede.

```
src/
  common/
    aws/              cliente do SQS
    mensageria/       envelope, consumidor SQS (long polling, só apaga depois de processar) e publicador
    observability/    New Relic, eventos de log e contexto do fluxo (correlationId do envelope)
    guards/           JWT com papéis e token do webhook externo
  core/config/        validação das variáveis de ambiente e prefixo das rotas
  modules/
    prisma/           conexão com o PostgreSQL (TLS com a CA do RDS)
    health/           liveness e readiness (SELECT 1)
    orcamento/
      domain/         Orcamento, Pagamento, ciclo de status, dinheiro, erros e portas de persistência
      application/
        ports/        portas: publicador de respostas, gateway de pagamento, notificador
        use-case/     um caso de uso por comando ou ação (gerar, decidir, processar aviso, cancelar, estornar, consultar)
        shared/       estorno de pagamento (usado em três fluxos), leitura e validação do comando, erros → HTTP
        dto/          entradas e respostas da API (Swagger)
      infra/
        prisma/       repositórios e transação no PostgreSQL
        mercado-pago/ adaptador da API do Mercado Pago
        notificacao/  e-mails pela Lambda /mail
      interface/
        controller/   rotas de orçamentos, pagamentos e webhooks
        consumer/     consumidor da fila de comandos (um caso de uso por tipo)
        presenter/    formato do orçamento nas respostas
prisma/               schema e migrations
k8s/                  namespace, ConfigMap, Job de migração, Deployment, Service, HPA, Ingress e PDB
terraform/            fila, DLQ, RDS, ECR e permissões
localstack/           criação das filas no LocalStack
mercado-pago-simulador/  respostas simuladas da API do Mercado Pago (WireMock)
scripts/              teste de ponta a ponta
```

A base comum (`common/`, `core/`, `auth`, `health`) é a mesma nos três serviços. Mudanças nela devem ser feitas nos três.

## Tecnologias

NestJS 11 · TypeScript · Node.js 24 · PostgreSQL 17 (Amazon RDS) · Prisma 7 · Amazon SQS · AWS SDK v3 · Mercado Pago (QR Code dinâmico, Orders API) · `qrcode` · Jest · logs JSON com `nestjs-pino` e `correlationId` · agente New Relic · Docker · LocalStack · WireMock · Kubernetes (EKS) · Terraform · GitHub Actions

## Rodando localmente

Com Docker, o compose sobe o PostgreSQL, o SQS (LocalStack) e o simulador do Mercado Pago, aplica as migrations e inicia o serviço:

```bash
cp .env.example .env    # ajuste JWT_SECRET para o mesmo segredo do OS Service
docker compose up --build
```

- Saúde: `http://localhost:3001/billing/health/ready`
- Swagger: `http://localhost:3001/billing/api`

Sem Docker para o serviço (as dependências ainda são necessárias): `docker compose up -d postgres localstack mercado-pago`, depois `npm ci && npx prisma generate && npx prisma migrate deploy && npm run start:dev` (porta 3000).

### Teste de ponta a ponta

Com o compose no ar, [`scripts/teste-ponta-a-ponta.sh`](scripts/teste-ponta-a-ponta.sh) faz o papel do OS Service: publica comandos na fila, lê as respostas da Saga e chama as rotas como cliente, funcionário, sistema externo e Mercado Pago.

```bash
bash scripts/teste-ponta-a-ponta.sh
```

São 45 verificações em cinco cenários:

1. caminho feliz até o estorno: orçamento, aprovação com o QR Code (conteúdo e imagem), pagamento e falha no reparo;
2. recusa pelo cliente;
3. aprovação externa, tentativa recusada (a order continua aberta) e pagamento pelo mesmo QR Code;
4. cancelamento pelo funcionário com a order cancelada no Mercado Pago, e um pagamento que chega depois e é estornado;
5. OS sem linhas, Mercado Pago fora na aprovação, aviso de order desconhecida e de outro tópico.

O script também confere a idempotência: comando repetido, aviso repetido e estorno repetido.

## Testes e cobertura

```bash
npm test            # testes unitários
npm run test:cov    # com cobertura; falha abaixo de 80% de linhas e instruções
```

Resultado atual: **230 testes, 97% de linhas** (97,3% de instruções, 85,3% de branches, 98,3% de funções). Os dublês usados pelos testes (`testes-de-apoio.ts`) ficam fora da conta, para não inflar o número.

| Camada | O que os testes cobrem |
|---|---|
| Domínio | ciclo do orçamento (transições válidas e recusadas) e contas em centavos |
| Casos de uso | cada fluxo da tabela [Fluxos da Saga](#fluxos-da-saga), com dublês em memória que reproduzem o banco (rollback quando a transação falha, chave única e gravação condicional): idempotência, corridas (pagamento × cancelamento), falha na publicação, Mercado Pago fora |
| Infraestrutura | chamadas ao Mercado Pago (corpo, headers, idempotência, os 409 do cancelamento e do estorno, timeout e novas tentativas), e-mails com o QR Code embutido e o HTML escapado, mapeamento do Prisma |
| Interface | rotas, QR Code na resposta (imagem PNG), leitura do aviso do Mercado Pago (tópico `order`, no corpo ou na query) e roteamento dos comandos |

O CI (`.github/workflows/ci.yml`) roda lint, testes com cobertura e build em todo PR; o check `Build & Test` é obrigatório para o merge na `main`. No push na `develop` e na `main`, o mesmo CI roda como primeiro estágio do [deploy](#deploy).

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `JWT_SECRET` | Mesmo segredo do OS Service e da Lambda de autenticação |
| `WEBHOOK_ORCAMENTO_TOKEN` | Token do sistema externo de aprovação (header `x-webhook-token`) |
| `DATABASE_URL` | PostgreSQL do Billing |
| `AWS_REGION` | Região da AWS |
| `BILLING_COMMANDS_QUEUE_URL` | Fila consumida |
| `SAGA_REPLIES_QUEUE_URL` | Fila das respostas para o orquestrador |
| `MERCADO_PAGO_ACCESS_TOKEN` | Access Token (de teste) da aplicação de QR Code |
| `MERCADO_PAGO_CAIXA_ID` | `external_id` do caixa a que as cobranças ficam ligadas ([configuração](#configuração-da-conta-de-teste-uma-vez)) |
| `MERCADO_PAGO_API_URL` | Opcional. Padrão: `https://api.mercadopago.com`; nos testes, o simulador |
| `MAIL_LAMBDA_URL` e `MAIL_LAMBDA_TOKEN` | Opcionais. Lambda de e-mail; sem elas, nenhum e-mail é enviado |
| `AWS_ENDPOINT_URL` | Só localmente: aponta para o LocalStack |

## Deploy

O deploy é automático, pelo workflow `.github/workflows/cd.yml`, a cada push na `develop` e na `main`. As duas branches vão para o mesmo cluster.

```mermaid
flowchart LR
    CI["CI<br/>lint · testes (mínimo 80%) · build"]
    AMB{"Ambiente<br/>no ar?"}
    IMG["Imagem<br/>ECR oficina-billing-service"]
    DEP["Deploy no EKS<br/>Secret do SSM · ConfigMap · migração · rollout"]
    SMK["Smoke test"]
    PULA["Pulado, com aviso"]

    CI --> IMG
    AMB -->|sim| IMG
    AMB -->|não| PULA
    IMG --> DEP --> SMK
```

| Estágio | O que faz |
|---|---|
| CI | O mesmo workflow dos PRs (`ci.yml`). Se falhar, nada é publicado. |
| Ambiente na AWS | O ambiente só existe nas janelas de integração e demonstração. Sem o secret `AWS_ROLE_ARN` ou sem o cluster `tc3-oficina-homolog`, a imagem e o deploy são pulados com um aviso no resumo da execução. Qualquer outro erro falha o pipeline. |
| Build & Push (ECR) | Imagem `linux/amd64` com duas tags: o commit e a branch. |
| Deploy (EKS) | Monta o Secret `billing-secret` a partir do SSM, aplica o ConfigMap com o endereço do API Gateway lido do SSM, roda o Job de migração (`prisma migrate deploy`) e só então aplica Deployment, Service, HPA, Ingress e PDB, esperando o rollout. Um deploy por vez. |
| Smoke test | Readiness com o banco, rotas protegidas respondendo 401 sem JWT e com token de webhook errado, e o HPA com ao menos duas réplicas. Não grava dados: o fluxo com os outros serviços é conferido pelo smoke test do OS Service. |

Os manifestos ficam em `k8s/`, no namespace `oficina-billing`, numerados na ordem de aplicação. O Ingress compartilha o ALB dos três serviços (`group.name: oficina`) e encaminha `/billing` para este serviço. A lista de parâmetros do SSM está em [`terraform/README.md`](terraform/README.md).

A infraestrutura AWS do serviço (fila, banco, repositório de imagens, parâmetros e permissões) está em [`terraform/`](terraform/README.md). O pipeline assume a role `tc3-github-actions` por OIDC, sem chave de acesso guardada no GitHub. O secret `AWS_ROLE_ARN` é o ARN dessa role, e o repositório precisa estar na lista de repositórios aceitos por ela (`bootstrap/` de `tc3-infra-k8s`).

## Fluxo de trabalho

- Branch a partir da `develop` → PR para a `develop` → PR da `develop` para a `main`.
- A `main` é protegida: exige PR com uma aprovação, o check `Build & Test` verde e a branch atualizada, e vale também para administradores.
- Mudança de contrato (mensagem, fila ou rota usada por outro serviço) começa por um PR em `docs/contratos.md` no OS Service, e só depois é feita nos serviços.
- Mudança na base comum (`src/common/`, `src/core/`, `auth`, `health`) é feita nos três serviços.

## Decisões e limites

- **Um orçamento por OS.** Recusa e cancelamento encerram a OS na Saga, então nunca há um segundo orçamento. O `osId` único é a chave da idempotência do `GerarOrcamento`.
- **QR Code dinâmico, e não Checkout Pro.** O link "Acesse a documentação" do PDF do desafio aponta para a integração do QR Code dinâmico; o serviço segue esse produto. A troca ficou contida no adaptador da porta `GatewayPagamento`: a regra de negócio é a mesma.
- **A cobrança só existe depois da aprovação.** A order é criada na aprovação, e não junto com o orçamento: o cliente não recebe cobrança de algo que ainda não aceitou.
- **Pagamento recusado não encerra a OS** (contratos, versão 1.1). A order continua aberta depois de uma recusa, então o cliente pode pagar de novo pelo mesmo QR Code, com outro cartão ou outro meio. O Mercado Pago não avisa recusas, então elas não ficam registradas aqui nem chegam à Saga (contratos, versão 1.2). A OS só avança com um pagamento confirmado. Se o cliente desistir ou o QR Code expirar, o funcionário cancela a OS, e o `CancelarOrcamento` cancela a order. Um pagamento aprovado que ainda chegue depois disso é estornado.
- **Cobrança criada e não usada.** Se a gravação da aprovação falhar depois de a order ser criada, uma nova aprovação devolve a mesma order (chave de idempotência por orçamento, válida por 24 h). Sem nova aprovação, ninguém recebe o QR Code e a order expira no prazo. Não há compensação para isso porque não há cobrança.
- **Assinatura do webhook do Mercado Pago não é validada.** A segurança vem da consulta da order na API, que é a regra do contrato. A validação do header `x-signature` ficaria como extra.
- **Sem tabela de mensagens processadas e sem outbox.** A idempotência vem do estado e das chaves naturais, e a consistência entre gravar e publicar vem da publicação dentro da transação, como definido nos contratos.
