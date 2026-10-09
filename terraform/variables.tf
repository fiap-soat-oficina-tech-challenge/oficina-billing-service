variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project_name" {
  description = "Prefixo dos parâmetros SSM, o mesmo usado pela infraestrutura da Fase 3."
  type        = string
  default     = "tc3-oficina"
}

variable "environment" {
  type    = string
  default = "homolog"
}

variable "state_bucket" {
  description = "Bucket do state remoto — o mesmo criado no bootstrap de tc3-infra-k8s."
  type        = string
}

variable "db_name" {
  type    = string
  default = "billing_db"
}

variable "db_username" {
  type    = string
  default = "billing_user"
}

variable "db_engine_version" {
  description = "Só a major: o RDS escolhe a minor suportada na criação (mesma regra de tc3-infra-db)."
  type        = string
  default     = "17"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}
