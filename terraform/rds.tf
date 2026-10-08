# Banco próprio do Billing (PostgreSQL, SQL): orçamentos, pagamentos e estornos.
# Mesmo desenho do banco do OS em tc3-infra-db: subnet privada, storage
# criptografado e acesso só a partir dos nós do EKS.

resource "aws_db_subnet_group" "billing" {
  name       = "oficina-billing-db"
  subnet_ids = local.private_subnet_ids
}

resource "aws_security_group" "billing_db" {
  name        = "oficina-billing-db"
  description = "Postgres do Billing acessivel apenas dos nos do EKS"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "dos_nos_eks" {
  security_group_id            = aws_security_group.billing_db.id
  description                  = "Postgres a partir dos nos do EKS"
  referenced_security_group_id = local.node_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "random_password" "billing_db" {
  length  = 32
  special = false # pontuação quebra o parsing da connection string do Prisma
}

resource "aws_db_instance" "billing" {
  identifier = "oficina-billing-db"

  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  db_name  = var.db_name
  username = var.db_username
  password = random_password.billing_db.result

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 2
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.billing.name
  vpc_security_group_ids = [aws_security_group.billing_db.id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period = 1
  skip_final_snapshot     = true
  deletion_protection     = false

  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  apply_immediately = true
}

# Credencial só no SSM, como no OS: nenhuma senha passa por secret do GitHub ou
# manifesto do Kubernetes. O CD lê daqui e monta o Secret do serviço.
resource "aws_ssm_parameter" "billing_database_url" {
  name        = "${local.ssm_prefix}/billing/DATABASE_URL"
  description = "Connection string do Prisma do Billing"
  type        = "SecureString"
  value = format(
    "postgresql://%s:%s@%s:%s/%s?schema=public",
    var.db_username,
    random_password.billing_db.result,
    aws_db_instance.billing.address,
    aws_db_instance.billing.port,
    var.db_name,
  )
}
