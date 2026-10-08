# Infraestrutura do Billing Service

Terraform dos recursos AWS que pertencem a este serviço:

- Fila `oficina-billing-commands` e a DLQ `oficina-billing-commands-dlq`
- RDS PostgreSQL próprio (`oficina-billing-db`), em subnet privada, acessível só dos nós do EKS
- Parâmetro `/tc3-oficina/homolog/billing/DATABASE_URL` no SSM
- Repositório de imagens `oficina-billing-service` no ECR
- Política de acesso anexada à role dos nós do EKS: consumir a própria fila e publicar em `oficina-os-saga-replies`

## Dependências e ordem

A VPC e o cluster vêm de [`tc3-infra-k8s`](https://github.com/tiagostorch/tc3-infra-k8s), lidos pelo state remoto. Por isso:

- **apply:** depois de `tc3-infra-k8s`;
- **destroy:** antes de `tc3-infra-k8s`, porque a AWS não apaga a role dos nós com esta política ainda anexada.

## Comandos

```bash
cd terraform
terraform init -backend-config="bucket=tc3-tfstate-oficina-539820"
terraform plan  -var="state_bucket=tc3-tfstate-oficina-539820"
terraform apply -var="state_bucket=tc3-tfstate-oficina-539820"
```

O state fica em `billing-service/terraform.tfstate`, no mesmo bucket das stacks da Fase 3.
