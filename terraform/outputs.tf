output "fila_url" {
  description = "Fila consumida por este serviço."
  value       = aws_sqs_queue.principal.url
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.url
}

output "ecr_repository_url" {
  description = "Destino do docker push no pipeline do serviço."
  value       = aws_ecr_repository.servico.repository_url
}

output "db_endpoint" {
  value = aws_db_instance.billing.address
}

output "ssm_database_url_name" {
  value = aws_ssm_parameter.billing_database_url.name
}
