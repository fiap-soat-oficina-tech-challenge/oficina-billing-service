# Simulador do Mercado Pago

[WireMock](https://wiremock.org/) com as respostas da API do Mercado Pago que o Billing usa. Sobe no `docker compose` e é usado nos testes locais e no BDD com os três serviços, porque o pagamento real exige um navegador e um cartão de teste.

O Billing aponta para ele pela variável `MERCADO_PAGO_API_URL`; o código é o mesmo usado contra a API real.

| Chamada | Resposta do simulador |
|---|---|
| `POST /checkout/preferences` | 201, preferência `pref-<id do orçamento>` com o link |
| `PUT /checkout/preferences/{id}` | 200 (link expirado) |
| `POST /v1/payments/{id}/refunds` | 201, estorno aprovado |
| `GET /v1/payments/{id}` | 404, até o teste cadastrar o pagamento |

## Simulando um pagamento

O teste cadastra o pagamento no simulador (API de administração do WireMock) e depois manda o aviso ao webhook do Billing, como o Mercado Pago faria:

```bash
ORCAMENTO_ID=...   # id devolvido por GET /billing/orcamentos?osId=...

curl -s -X POST http://localhost:8089/__admin/mappings -d '{
  "request": { "method": "GET", "urlPath": "/v1/payments/9001" },
  "response": { "status": 200, "jsonBody": {
    "id": 9001, "status": "approved", "status_detail": "accredited",
    "external_reference": "'"$ORCAMENTO_ID"'", "transaction_amount": 150.2,
    "date_approved": "2026-10-20T14:30:00.000-03:00" } }
}'

curl -s -X POST http://localhost:3001/billing/webhooks/mercado-pago \
  -H 'Content-Type: application/json' \
  -d '{"type": "payment", "action": "payment.updated", "data": {"id": "9001"}}'
```

Para um pagamento recusado, use `"status": "rejected"` e `"status_detail": "cc_rejected_other_reason"`.
