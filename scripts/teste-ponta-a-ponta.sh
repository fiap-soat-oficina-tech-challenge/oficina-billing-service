#!/usr/bin/env bash
# Teste de ponta a ponta do Billing com as dependências do docker compose
# (PostgreSQL, SQS no LocalStack e o simulador do Mercado Pago).
#
# Faz o papel do OS Service: publica os comandos na fila do Billing, lê as
# respostas na fila da Saga e chama as rotas REST como cliente, funcionário,
# sistema externo e Mercado Pago.
#
# Uso (na raiz do repositório, com o .env criado a partir do .env.example):
#   docker compose up -d --build
#   bash scripts/teste-ponta-a-ponta.sh
set -uo pipefail

API=http://localhost:3001/billing
MP=http://localhost:8089
FILA_COMANDOS=http://localhost:4566/000000000000/oficina-billing-commands
FILA_RESPOSTAS=http://localhost:4566/000000000000/oficina-os-saga-replies
JWT_SECRET=$(grep '^JWT_SECRET=' .env | cut -d= -f2-)
WEBHOOK_TOKEN=$(grep '^WEBHOOK_ORCAMENTO_TOKEN=' .env | cut -d= -f2-)
CLIENTE_ID=9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a

FALHAS=0
VERIFICACOES=0

ok()    { VERIFICACOES=$((VERIFICACOES + 1)); echo "  ok   $1"; }
falha() { VERIFICACOES=$((VERIFICACOES + 1)); FALHAS=$((FALHAS + 1)); echo "  FALHA $1"; }
confere() { if [ "$2" = "$3" ]; then ok "$1"; else falha "$1 (esperado '$3', veio '$2')"; fi; }
uuid()  { python3 -c "import uuid;print(uuid.uuid4())"; }
campo() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }
awslocal() { docker compose exec -T localstack awslocal "$@"; }

# JWT HS256 assinado com o mesmo segredo do serviço.
jwt() {
  node -e '
    const c = require("node:crypto");
    const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const corpo = { ...JSON.parse(process.argv[2]), exp: Math.floor(Date.now() / 1000) + 3600 };
    const dados = b({ alg: "HS256", typ: "JWT" }) + "." + b(corpo);
    console.log(dados + "." + c.createHmac("sha256", process.argv[1]).update(dados).digest("base64url"));
  ' "$JWT_SECRET" "$1"
}
TOKEN_CLIENTE=$(jwt "{\"sub\":\"$CLIENTE_ID\",\"tipo\":\"cliente\",\"cpf\":\"12345678909\",\"nome\":\"Maria\"}")
TOKEN_OUTRO_CLIENTE=$(jwt '{"sub":"outro-cliente","tipo":"cliente","cpf":"98765432100","nome":"Ana"}')
TOKEN_FUNCIONARIO=$(jwt '{"sub":"func-1","email":"admin@oficina.com"}')

# Publica um comando como o OS Service faria.
comando() {
  local tipo="$1" os="$2" payload="$3"
  local corpo
  corpo=$(python3 -c '
import json, sys, uuid, datetime
print(json.dumps({"messageId": str(uuid.uuid4()), "correlationId": "fluxo-" + sys.argv[2][:8],
  "osId": sys.argv[2], "tipo": sys.argv[1],
  "ocorridoEm": datetime.datetime.now(datetime.timezone.utc).isoformat(),
  "payload": json.loads(sys.argv[3])}))' "$tipo" "$os" "$payload")
  awslocal sqs send-message --queue-url "$FILA_COMANDOS" --message-body "$corpo" >/dev/null
}

# Espera a próxima resposta da Saga e imprime "tipo|osId|correlationId|payload".
resposta() {
  local saida
  for _ in 1 2 3 4 5 6; do
    saida=$(awslocal sqs receive-message --queue-url "$FILA_RESPOSTAS" --wait-time-seconds 5 \
      --max-number-of-messages 1 --output json)
    if [ -n "$saida" ] && echo "$saida" | grep -q ReceiptHandle; then
      local handle
      handle=$(echo "$saida" | campo "['Messages'][0]['ReceiptHandle']")
      awslocal sqs delete-message --queue-url "$FILA_RESPOSTAS" --receipt-handle "$handle"
      echo "$saida" | python3 -c '
import json, sys
m = json.loads(json.load(sys.stdin)["Messages"][0]["Body"])
print("|".join([m["tipo"], m["osId"], m["correlationId"], json.dumps(m["payload"], sort_keys=True)]))'
      return
    fi
  done
  echo "nenhuma"
}

# Fila de respostas vazia (nenhuma resposta a mais do que o esperado).
sem_resposta() {
  local r
  r=$(awslocal sqs receive-message --queue-url "$FILA_RESPOSTAS" --wait-time-seconds 3 --output json)
  if echo "$r" | grep -q ReceiptHandle; then falha "$1 (chegou resposta a mais)"; else ok "$1"; fi
}

payload_orcamento() {
  cat <<JSON
{"codigo": "$1", "cliente": {"id": "$CLIENTE_ID", "nome": "Maria Silva", "email": null},
 "servicos": [{"servicoId": "srv-1", "nome": "Troca de óleo", "precoUnitario": 120, "quantidade": 1, "subtotal": 120}],
 "itens": [{"itemEstoqueId": "item-1", "nome": "Filtro de óleo", "precoUnitario": 15.1, "quantidade": 2, "subtotal": 30.2}],
 "valorServicos": 120, "valorPecas": 30.2, "valorTotal": 150.2}
JSON
}

# Cadastra no simulador o pagamento que o Mercado Pago devolveria em GET /v1/payments/{id}.
pagamento_no_mp() {
  local id="$1" status="$2" detalhe="$3" orcamento="$4"
  curl -s -X POST "$MP/__admin/mappings" -d "{
    \"request\": {\"method\": \"GET\", \"urlPath\": \"/v1/payments/$id\"},
    \"response\": {\"status\": 200, \"headers\": {\"Content-Type\": \"application/json\"}, \"jsonBody\": {
      \"id\": $id, \"status\": \"$status\", \"status_detail\": \"$detalhe\",
      \"external_reference\": \"$orcamento\", \"transaction_amount\": 150.2,
      \"date_approved\": \"2026-10-20T14:30:00.000-03:00\"}}}" >/dev/null
}

aviso_mp() {
  curl -s -X POST "$API/webhooks/mercado-pago" -H 'Content-Type: application/json' \
    -d "{\"type\": \"payment\", \"action\": \"payment.updated\", \"data\": {\"id\": \"$1\"}, \"live_mode\": false}" |
    campo "['resultado']"
}

orcamento_da_os() {
  curl -s "$API/orcamentos?osId=$1" -H "Authorization: Bearer $TOKEN_FUNCIONARIO" | campo "[0]['$2']"
}

http_status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== Preparação"
confere "serviço pronto (banco conectado)" "$(http_status "$API/health/ready")" 200
awslocal sqs purge-queue --queue-url "$FILA_RESPOSTAS" >/dev/null 2>&1
curl -s -X POST "$MP/__admin/requests/reset" >/dev/null

echo "== 1. Caminho feliz: orçamento → aprovação → pagamento → estorno (falha no reparo)"
OS1=$(uuid); C1="OS-2026-$(python3 -c 'import random;print(random.randint(100000,999999))')"
comando GerarOrcamento "$OS1" "$(payload_orcamento "$C1")"
R=$(resposta); IFS='|' read -r TIPO OS_R CORR PAYLOAD <<<"$R"
confere "GerarOrcamento → OrcamentoEnviado" "$TIPO" OrcamentoEnviado
confere "resposta com o osId e o correlationId do comando" "$OS_R|$CORR" "$OS1|fluxo-${OS1:0:8}"
ORC1=$(orcamento_da_os "$OS1" id)
confere "valorTotal na resposta" "$(echo "$PAYLOAD" | campo "['valorTotal']")" 150.2
confere "orçamento aguardando aprovação" "$(orcamento_da_os "$OS1" status)" AGUARDANDO_APROVACAO

comando GerarOrcamento "$OS1" "$(payload_orcamento "$C1")"
sem_resposta "GerarOrcamento repetido não gera outra resposta"

confere "outro cliente não vê o orçamento (404)" \
  "$(http_status "$API/orcamentos/$ORC1" -H "Authorization: Bearer $TOKEN_OUTRO_CLIENTE")" 404
confere "funcionário não aprova pelo cliente (403)" \
  "$(http_status -X POST "$API/orcamentos/$ORC1/aprovar" -H "Authorization: Bearer $TOKEN_FUNCIONARIO")" 403

APROVACAO=$(curl -s -X POST "$API/orcamentos/$ORC1/aprovar" -H "Authorization: Bearer $TOKEN_CLIENTE")
confere "aprovação devolve o link do sandbox" "$(echo "$APROVACAO" | campo "['linkPagamento']")" \
  "http://localhost:8089/sandbox/checkout/pref-$ORC1"
R=$(resposta); IFS='|' read -r TIPO _ _ PAYLOAD <<<"$R"
confere "aprovação → OrcamentoAprovado (origem CLIENTE)" "$TIPO $(echo "$PAYLOAD" | campo "['origem']")" "OrcamentoAprovado CLIENTE"
confere "aprovar de novo é 409" \
  "$(http_status -X POST "$API/orcamentos/$ORC1/aprovar" -H "Authorization: Bearer $TOKEN_CLIENTE")" 409

pagamento_no_mp 9101 approved accredited "$ORC1"
confere "aviso do Mercado Pago (aprovado)" "$(aviso_mp 9101)" PAGAMENTO_CONFIRMADO
R=$(resposta); IFS='|' read -r TIPO _ _ PAYLOAD <<<"$R"
confere "→ PagamentoConfirmado com o id do Mercado Pago" "$TIPO $(echo "$PAYLOAD" | campo "['pagamentoId']")" "PagamentoConfirmado 9101"
confere "orçamento PAGO" "$(orcamento_da_os "$OS1" status)" PAGO
confere "aviso repetido não é tratado de novo" "$(aviso_mp 9101)" JA_PROCESSADO

comando EstornarPagamento "$OS1" '{"motivo": "Reparo falhou: peça indisponível"}'
R=$(resposta); IFS='|' read -r TIPO _ _ _ <<<"$R"
confere "EstornarPagamento → PagamentoEstornado" "$TIPO" PagamentoEstornado
confere "orçamento cancelado" "$(orcamento_da_os "$OS1" status)" CANCELADO
PAGAMENTOS=$(curl -s "$API/pagamentos?osId=$OS1" -H "Authorization: Bearer $TOKEN_FUNCIONARIO")
confere "pagamento estornado, com o motivo" \
  "$(echo "$PAGAMENTOS" | campo "[0]['status']") $(echo "$PAGAMENTOS" | campo "[0]['motivoEstorno']")" \
  "ESTORNADO Reparo falhou: peça indisponível"
confere "estorno chamado no Mercado Pago com a chave de idempotência" \
  "$(curl -s "$MP/__admin/requests" | python3 -c 'import json,sys;r=[x["request"] for x in json.load(sys.stdin)["requests"] if x["request"]["url"].endswith("/9101/refunds")];print(r[0]["headers"].get("X-Idempotency-Key") if r else "")')" \
  estorno-9101
comando EstornarPagamento "$OS1" '{"motivo": "repetido"}'
sem_resposta "EstornarPagamento repetido não estorna de novo"

echo "== 2. Cliente recusa o orçamento"
OS2=$(uuid)
comando GerarOrcamento "$OS2" "$(payload_orcamento "OS-2026-$(python3 -c 'import random;print(random.randint(100000,999999))')")"
resposta >/dev/null
ORC2=$(orcamento_da_os "$OS2" id)
curl -s -X POST "$API/orcamentos/$ORC2/recusar" -H "Authorization: Bearer $TOKEN_CLIENTE" \
  -H 'Content-Type: application/json' -d '{"motivo": "Valor acima do esperado"}' >/dev/null
R=$(resposta); IFS='|' read -r TIPO _ _ PAYLOAD <<<"$R"
confere "recusa → OrcamentoRecusado com o motivo" "$TIPO $(echo "$PAYLOAD" | campo "['motivo']")" \
  "OrcamentoRecusado Valor acima do esperado"
confere "orçamento recusado" "$(orcamento_da_os "$OS2" status)" RECUSADO

echo "== 3. Sistema externo aprova, pagamento é recusado e a Saga cancela"
OS3=$(uuid); C3="OS-2026-$(python3 -c 'import random;print(random.randint(100000,999999))')"
comando GerarOrcamento "$OS3" "$(payload_orcamento "$C3")"
resposta >/dev/null
ORC3=$(orcamento_da_os "$OS3" id)
confere "webhook externo sem token é 401" \
  "$(http_status -X POST "$API/webhooks/orcamento" -H 'Content-Type: application/json' -d "{\"codigoOS\": \"$C3\", \"aprovado\": true}")" 401
curl -s -X POST "$API/webhooks/orcamento" -H "x-webhook-token: $WEBHOOK_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"codigoOS\": \"$C3\", \"aprovado\": true}" >/dev/null
R=$(resposta); IFS='|' read -r TIPO _ _ PAYLOAD <<<"$R"
confere "→ OrcamentoAprovado (origem SISTEMA_EXTERNO)" "$TIPO $(echo "$PAYLOAD" | campo "['origem']")" \
  "OrcamentoAprovado SISTEMA_EXTERNO"
pagamento_no_mp 9301 rejected cc_rejected_other_reason "$ORC3"
confere "aviso do Mercado Pago (recusado)" "$(aviso_mp 9301)" PAGAMENTO_RECUSADO
R=$(resposta); IFS='|' read -r TIPO _ _ PAYLOAD <<<"$R"
confere "→ PagamentoRecusado com o status_detail" "$TIPO $(echo "$PAYLOAD" | campo "['detalhe']")" \
  "PagamentoRecusado cc_rejected_other_reason"
comando CancelarOrcamento "$OS3" '{"motivo": "PAGAMENTO_RECUSADO"}'
sleep 3
confere "CancelarOrcamento cancela o orçamento" "$(orcamento_da_os "$OS3" status)" CANCELADO
confere "e expira o link no Mercado Pago" \
  "$(curl -s "$MP/__admin/requests" | python3 -c "import json,sys;print(any(x['request']['method']=='PUT' and x['request']['url']=='/checkout/preferences/pref-$ORC3' for x in json.load(sys.stdin)['requests']))")" \
  True
sem_resposta "cancelamento sem pagamento não gera resposta"

echo "== 4. Pagamento aprovado depois do cancelamento é estornado"
OS4=$(uuid)
comando GerarOrcamento "$OS4" "$(payload_orcamento "OS-2026-$(python3 -c 'import random;print(random.randint(100000,999999))')")"
resposta >/dev/null
ORC4=$(orcamento_da_os "$OS4" id)
curl -s -X POST "$API/orcamentos/$ORC4/aprovar" -H "Authorization: Bearer $TOKEN_CLIENTE" >/dev/null
resposta >/dev/null
comando CancelarOrcamento "$OS4" '{"motivo": "Cancelada pelo funcionário"}'
sleep 3
pagamento_no_mp 9401 approved accredited "$ORC4"
confere "aviso de pagamento depois do cancelamento" "$(aviso_mp 9401)" PAGAMENTO_ESTORNADO
R=$(resposta); IFS='|' read -r TIPO _ _ _ <<<"$R"
confere "→ PagamentoEstornado" "$TIPO" PagamentoEstornado
confere "orçamento continua cancelado" "$(orcamento_da_os "$OS4" status)" CANCELADO

echo "== 5. Falhas de negócio e de dependência"
OS5=$(uuid)
comando GerarOrcamento "$OS5" "{\"codigo\": \"OS-2026-000005\", \"cliente\": {\"id\": \"$CLIENTE_ID\", \"nome\": \"Maria\"}, \"servicos\": [], \"itens\": [], \"valorServicos\": 0, \"valorPecas\": 0, \"valorTotal\": 0}"
R=$(resposta); IFS='|' read -r TIPO _ _ PAYLOAD <<<"$R"
confere "OS sem linhas → GeracaoOrcamentoFalhou ORCAMENTO_VAZIO" "$TIPO $(echo "$PAYLOAD" | campo "['motivo']")" \
  "GeracaoOrcamentoFalhou ORCAMENTO_VAZIO"

OS6=$(uuid)
comando GerarOrcamento "$OS6" "$(payload_orcamento "OS-2026-$(python3 -c 'import random;print(random.randint(100000,999999))')")"
resposta >/dev/null
ORC6=$(orcamento_da_os "$OS6" id)
curl -s -X POST "$MP/__admin/mappings" -d '{"priority": 1, "request": {"method": "POST", "urlPath": "/checkout/preferences"},
  "response": {"status": 500}, "metadata": {"teste": "mp-fora"}}' >/dev/null
confere "Mercado Pago fora na aprovação → 503" \
  "$(http_status -X POST "$API/orcamentos/$ORC6/aprovar" -H "Authorization: Bearer $TOKEN_CLIENTE")" 503
confere "e o orçamento continua aguardando aprovação" "$(orcamento_da_os "$OS6" status)" AGUARDANDO_APROVACAO
sem_resposta "nenhuma resposta publicada"
curl -s -X POST "$MP/__admin/mappings/remove-by-metadata" -d '{"matchesJsonPath": "$.teste"}' >/dev/null

confere "aviso do Mercado Pago de pagamento desconhecido é ignorado" "$(aviso_mp 123456)" IGNORADO

echo
echo "== Resultado: $((VERIFICACOES - FALHAS))/$VERIFICACOES verificações ok"
[ "$FALHAS" -eq 0 ]
