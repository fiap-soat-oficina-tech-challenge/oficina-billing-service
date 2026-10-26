# Infraestrutura do Billing Service

Terraform dos recursos AWS que pertencem a este serviço:

- Fila `oficina-billing-commands` e a DLQ `oficina-billing-commands-dlq`
- RDS PostgreSQL próprio (`oficina-billing-db`), em subnet privada, acessível só dos nós do EKS
- Parâmetros `/tc3-oficina/homolog/billing/DATABASE_URL` e `/tc3-oficina/homolog/billing/WEBHOOK_ORCAMENTO_TOKEN` no SSM
- Repositório de imagens `oficina-billing-service` no ECR
- Política de acesso anexada à role dos nós do EKS: consumir a própria fila e publicar em `oficina-os-saga-replies`

## Segredos que o serviço lê do SSM

O CD monta o Secret `billing-secret` do Kubernetes a partir destes parâmetros (prefixo `/tc3-oficina/homolog`). Nenhum valor passa por arquivo, manifesto ou secret do GitHub.

| Parâmetro | Origem |
|---|---|
| `billing/DATABASE_URL` | criado por esta stack (`rds.tf`) |
| `billing/WEBHOOK_ORCAMENTO_TOKEN` | gerado por esta stack (`ssm.tf`); quem integra o sistema externo de aprovação lê o mesmo parâmetro |
| `JWT_SECRET` | o mesmo do OS Service e da Lambda de autenticação (Fase 3) |
| `MAIL_API_TOKEN` | o mesmo do OS Service, gerado pela stack `tc3-auth-lambda` |
| `NEW_RELIC_LICENSE_KEY` | publicado por `tc3-infra-k8s` |
| `billing/MERCADO_PAGO_ACCESS_TOKEN` | **criado à mão**, com o Access Token de teste da aplicação do Checkout Pro (como os parâmetros `MAIL_*` da Fase 3: é credencial de conta externa e não sai do Terraform) |

O ConfigMap também depende de um parâmetro que não é segredo: `API_GATEWAY_URL`, o endereço do API Gateway publicado pela stack `tc3-auth-lambda`. O CD o usa para montar a URL do aviso do Mercado Pago e a da Lambda de e-mail, que mudam quando a plataforma é recriada.

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
