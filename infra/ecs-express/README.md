# ECS Express Mode (Fargate) migration notes

## 1) Build and push image

```bash
cd backend
docker build -t kakeibo-api:latest .
```

Push the image to ECR and set its URI to `container_image` in Terraform or to `image` in the AWS CLI task definition JSON.

## 2) Terraform deploy (ALB + ECS Fargate)

```bash
cd infra/terraform-ecs-express
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan
terraform apply
```

This stack creates:
- Public ALB (`0.0.0.0/0` by default; configurable via `allowed_cidr_blocks`)
- ECS Cluster / Fargate Service
- Task Definition with `cpu=512` and `memory=1024`
- CloudWatch Log Group
- Execution role and task role

## 3) IAM for Textract

Two options:
- Managed policy: `arn:aws:iam::aws:policy/AmazonTextractFullAccess`
- Least privilege example: `infra/iam/ecs-task-role-textract-minimum-policy.json`

Attach one of them to the ECS **task role** (not only execution role) so runtime code can call Textract.

## 4) Environment variables migration

App Runner environment variables map to ECS `containerDefinitions`:
- Plain values -> `environment`
- Sensitive values -> `secrets` (Secrets Manager / SSM Parameter Store ARN)

AWS CLI example JSON:
- `infra/ecs-express/task-definition.awscli.example.json`

Terraform equivalent:
- `app_env_vars` and `app_secret_arns` in `infra/terraform-ecs-express/variables.tf`
