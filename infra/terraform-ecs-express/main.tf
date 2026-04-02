data "aws_caller_identity" "current" {}

locals {
  app_name = var.name_prefix
  github_oidc_provider_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : var.github_oidc_provider_arn
  tags = {
    Project     = "kakeibo"
    Environment = "production"
    ManagedBy   = "terraform"
  }

  # ECS タスク定義の secrets の valueFrom を ARN 種別ごとに分け、実行ロールの IAM を出し分ける
  app_secret_arn_values     = values(var.app_secret_arns)
  execution_secretsmgr_arns = [for a in local.app_secret_arn_values : a if startswith(a, "arn:aws:secretsmanager:")]
  execution_ssm_param_arns  = [for a in local.app_secret_arn_values : a if startswith(a, "arn:aws:ssm:")]
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
  tags            = local.tags
}

resource "aws_cloudwatch_log_group" "ecs" {
  name              = "/ecs/${local.app_name}"
  retention_in_days = 30
  tags              = local.tags
}

resource "aws_ecr_repository" "api" {
  name                 = var.ecr_repository_name
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = local.tags
}

resource "aws_ecs_cluster" "this" {
  name = "${local.app_name}-cluster"
  tags = local.tags
}

resource "aws_security_group" "alb" {
  name        = "${local.app_name}-alb-sg"
  description = "Allow inbound web traffic"
  vpc_id      = var.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidr_blocks
  }

  dynamic "ingress" {
    for_each = trimspace(var.alb_certificate_arn) != "" ? [443] : []
    content {
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = var.allowed_cidr_blocks
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_security_group" "ecs_service" {
  name        = "${local.app_name}-ecs-sg"
  description = "Allow inbound from ALB only"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # 既に 0.0.0.0/0 で全 egress 許可のため ECS→RDS は到達可能。RDS 側 SG で 3306 を ECS タスク SG から許可すること（rds_security_group_id）
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# RDS のセキュリティグループに、ECS タスクからの MySQL のみインバウンドを追加（RDS を別スタックで作っている場合に指定）
resource "aws_vpc_security_group_ingress_rule" "rds_mysql_from_ecs" {
  count = trimspace(var.rds_security_group_id) != "" ? 1 : 0

  security_group_id            = var.rds_security_group_id
  referenced_security_group_id = aws_security_group.ecs_service.id
  ip_protocol                  = "tcp"
  from_port                    = var.rds_port
  to_port                      = var.rds_port

  tags = merge(local.tags, { Name = "${local.app_name}-rds-from-ecs" })
}

resource "aws_lb" "this" {
  name               = "${local.app_name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
  idle_timeout       = 60
  tags               = local.tags
}

resource "aws_lb_target_group" "this" {
  name        = "${local.app_name}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = var.health_check_path
    healthy_threshold   = 2
    unhealthy_threshold = 5
    interval            = 30
    timeout             = 5
    matcher             = "200-399"
  }

  tags = local.tags
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = trimspace(var.alb_certificate_arn) != "" ? "redirect" : "forward"
    target_group_arn = trimspace(var.alb_certificate_arn) == "" ? aws_lb_target_group.this.arn : null

    dynamic "redirect" {
      for_each = trimspace(var.alb_certificate_arn) != "" ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = trimspace(var.alb_certificate_arn) != "" ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.alb_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    effect = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.app_name}-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.app_secret_arns) > 0 ? 1 : 0

  dynamic "statement" {
    for_each = length(local.execution_secretsmgr_arns) > 0 ? [1] : []
    content {
      sid       = "ReadTaskSecretsFromSecretsManager"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.execution_secretsmgr_arns
    }
  }

  dynamic "statement" {
    for_each = length(local.execution_ssm_param_arns) > 0 ? [1] : []
    content {
      sid    = "ReadTaskParametersFromSSM"
      effect = "Allow"
      actions = [
        "ssm:GetParameters",
        "ssm:GetParameter",
      ]
      resources = local.execution_ssm_param_arns
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count  = length(var.app_secret_arns) > 0 ? 1 : 0
  name   = "${local.app_name}-execution-read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json

  lifecycle {
    precondition {
      condition     = length(local.execution_secretsmgr_arns) > 0 || length(local.execution_ssm_param_arns) > 0
      error_message = "app_secret_arns の各値は arn:aws:secretsmanager: または arn:aws:ssm: で始まるフル ARN にしてください。"
    }
  }
}

resource "aws_iam_role" "task" {
  name               = "${local.app_name}-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "task_textract_full" {
  role       = aws_iam_role.task.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonTextractFullAccess"
}

data "aws_iam_policy_document" "github_actions_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/${var.github_branch}"]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = "${local.app_name}-github-actions-deploy-role"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume_role.json
  tags               = local.tags
}

data "aws_iam_policy_document" "github_actions_deploy" {
  statement {
    sid    = "TerraformAndEcsDeploy"
    effect = "Allow"
    actions = [
      "ecs:*",
      "ecr:*",
      "elasticloadbalancing:*",
      "ec2:*",
      "logs:*",
      "iam:GetRole",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:PassRole",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:CreateOpenIDConnectProvider",
      "iam:GetOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "ssm:GetParameter",
      "ssm:GetParameters",
      "secretsmanager:GetSecretValue",
      "route53:GetChange",
      "route53:ListHostedZones",
      "route53:GetHostedZone",
      "route53:ListResourceRecordSets",
      "route53:ChangeResourceRecordSets"
    ]
    resources = ["*"]
  }

  statement {
    sid    = "TerraformStateS3Access"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject"
    ]
    resources = [
      "arn:aws:s3:::*",
      "arn:aws:s3:::*/*"
    ]
  }
}

resource "aws_iam_role_policy" "github_actions_deploy" {
  name   = "${local.app_name}-github-actions-deploy-policy"
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.github_actions_deploy.json
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${local.app_name}-task"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.container_image
      essential = true
      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]
      environment = [
        for k, v in var.app_env_vars : {
          name  = k
          value = v
        }
      ]
      secrets = [
        for k, arn in var.app_secret_arns : {
          name      = k
          valueFrom = arn
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.ecs.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])

  tags = local.tags
}

resource "aws_ecs_service" "this" {
  name            = "${local.app_name}-service"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs_service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "api"
    container_port   = var.container_port
  }

  depends_on = [
    aws_lb_listener.http,
    aws_vpc_endpoint.ecr_api,
    aws_vpc_endpoint.ecr_dkr,
    aws_vpc_endpoint.logs,
    aws_vpc_endpoint.secretsmanager,
    aws_vpc_endpoint.ssm,
    aws_vpc_endpoint.s3,
  ]
  tags = local.tags
}
