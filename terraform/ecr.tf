# Registry das imagens deste serviço. `force_delete`: as imagens são recriadas
# pelo build, e sem isso o destroy para num repositório com imagens (foi o que
# aconteceu com o ECR do OS no destroy de 05/10).

resource "aws_ecr_repository" "servico" {
  name                 = "oficina-billing-service"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "servico" {
  repository = aws_ecr_repository.servico.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Mantem apenas as 10 imagens mais recentes"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
