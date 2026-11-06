# Simulador do Mercado Pago

[WireMock](https://wiremock.org/) com as respostas da Orders API (QR Code dinâmico) que o Billing usa. Sobe no `docker compose` e é usado nos testes locais e no BDD com os três serviços, porque o pagamento real exige o app do Mercado Pago num celular.

O Billing aponta para ele pela variável `MERCADO_PAGO_API_URL`; o código é o mesmo usado contra a API real.

| Chamada | Resposta do simulador |
|---|---|
| `POST /v1/orders` | 201, order `ORD-<id do orçamento>` aberta (`created`), com um `type_response.qr_data` de mentira |
| `POST /v1/orders/{id}/cancel` | 200, order cancelada |
| `POST /v1/orders/{id}/refund` | 201, estorno em processamento |
| `GET /v1/orders/{id}` | 404, até o teste cadastrar a order paga |

## Simulando um pagamento

O id da order é previsível (`ORD-` + id do orçamento). O teste cadastra a order paga no simulador (API de administração do WireMock) e depois manda o aviso ao webhook do Billing, como o Mercado Pago faria:

```bash
ORCAMENTO_ID=...   # id devolvido por GET /billing/orcamentos?osId=...

curl -s -X POST http://localhost:8089/__admin/mappings -d '{
  "request": { "method": "GET", "urlPath": "/v1/orders/ORD-'"$ORCAMENTO_ID"'" },
  "response": { "status": 200, "jsonBody": {
    "id": "ORD-'"$ORCAMENTO_ID"'", "status": "processed", "status_detail": "accredited",
    "external_reference": "'"$ORCAMENTO_ID"'", "total_amount": "150.20", "total_paid_amount": "150.20",
    "last_updated_date": "2026-10-20T17:30:00.000Z" } }
}'

curl -s -X POST http://localhost:3001/billing/webhooks/mercado-pago \
  -H 'Content-Type: application/json' \
  -d '{"type": "order", "action": "order.processed", "data": {"id": "ORD-'"$ORCAMENTO_ID"'"}}'
```

Um pagamento recusado não tem o que simular: no QR Code, a order continua `created` e o Mercado Pago não manda aviso. O cliente paga de novo pelo mesmo QR Code.
