#!/bin/bash
# Cria no LocalStack as mesmas filas de terraform/sqs.tf, para o serviço rodar
# localmente sem AWS.
set -euo pipefail

awslocal sqs create-queue --queue-name oficina-billing-commands-dlq >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/oficina-billing-commands-dlq \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs create-queue --queue-name oficina-billing-commands \
  --attributes "{\"VisibilityTimeout\":\"60\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null

# Fila de respostas da Saga (é do OS Service; aqui só para receber o que este
# serviço publica).
awslocal sqs create-queue --queue-name oficina-os-saga-replies >/dev/null

echo "recursos do Billing criados no LocalStack"
