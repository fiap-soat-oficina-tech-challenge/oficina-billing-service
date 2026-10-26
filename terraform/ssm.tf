# Token do sistema externo de aprovação (POST /billing/webhooks/orcamento,
# header x-webhook-token). Gerado aqui e guardado só no SSM: o CD monta o Secret
# do Kubernetes a partir dele, e quem integra o sistema externo lê o mesmo
# parâmetro.

resource "random_password" "webhook_orcamento_token" {
  length  = 48
  special = false # vai em header HTTP; só letras e números
}

resource "aws_ssm_parameter" "webhook_orcamento_token" {
  name        = "${local.ssm_prefix}/billing/WEBHOOK_ORCAMENTO_TOKEN"
  description = "Token do webhook de aprovação externa do orçamento (Billing)"
  type        = "SecureString"
  value       = random_password.webhook_orcamento_token.result
}
