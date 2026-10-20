# ECS Fargate services behind an internet-facing ALB protected by AWS WAF.
#   https://<app_domain>/api/v1/*  → api      (same origin as the web app: first-party cookies)
#   https://<app_domain>/*         → web
#   https://<auth_domain>/*        → keycloak (admin console restricted to the admin allowlist)
#   worker                         → no inbound traffic
# Secrets are injected from Secrets Manager; nothing secret lives in task definitions.

variable "name" { type = string }
variable "vpc_id" { type = string }
variable "alb_security_group_id" { type = string }
variable "tasks_security_group_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "app_domain" { type = string }
variable "auth_domain" { type = string }
variable "certificate_arn" { type = string }
variable "images" { type = map(string) } # api, worker, web, keycloak → image@sha256 digest
variable "task_role_arns" { type = map(string) }
variable "task_role_names" { type = map(string) }
variable "execution_role_arn" { type = string }
variable "execution_role_name" { type = string }
variable "app_kms_key_arn" { type = string }
variable "data_kms_key_arn" { type = string }
variable "logs_kms_key_arn" { type = string }
variable "documents_bucket" { type = string }
variable "documents_bucket_arn" { type = string }
variable "audit_bucket" { type = string }
variable "audit_bucket_arn" { type = string }
variable "logs_bucket" { type = string }
variable "secret_arns" {
  type        = map(string)
  description = "database_url_app, database_url_worker, database_url_migrator, redis_url, oidc_client_secret, keycloak_admin_client_secret, ip_hash_key, keycloak_db_password, keycloak_admin_password"
}
variable "admin_ip_allowlist" {
  type        = list(string)
  description = "CIDRs allowed to reach the Keycloak admin console and (optionally) admin/finance roles"
}
variable "desired_count" {
  type    = number
  default = 2
}

data "aws_region" "current" {}

# ------------------------------------------------------------------ ALB + WAF

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [var.alb_security_group_id]
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  access_logs {
    bucket  = var.logs_bucket
    prefix  = "alb"
    enabled = true
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

locals {
  web_services = {
    api      = { port = 4000, health = "/api/v1/health/ready" }
    web      = { port = 3000, health = "/login" }
    keycloak = { port = 8080, health = "/realms/pmo/.well-known/openid-configuration" }
  }
}

resource "aws_lb_target_group" "svc" {
  for_each    = local.web_services
  name        = "${var.name}-${each.key}"
  port        = each.value.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = each.value.health
    matcher = "200"
  }
}

# Keycloak admin console: allowlisted source IPs only (ALB rules evaluate in priority order).
resource "aws_lb_listener_rule" "keycloak_admin_allow" {
  count        = length(var.admin_ip_allowlist) > 0 ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 4
  condition {
    host_header { values = [var.auth_domain] }
  }
  condition {
    path_pattern { values = ["/admin/*", "/admin"] }
  }
  condition {
    source_ip { values = var.admin_ip_allowlist }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["keycloak"].arn
  }
}

resource "aws_lb_listener_rule" "keycloak_admin_block" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 5
  condition {
    host_header { values = [var.auth_domain] }
  }
  condition {
    path_pattern { values = ["/admin/*", "/admin"] }
  }
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "keycloak" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  condition {
    host_header { values = [var.auth_domain] }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["keycloak"].arn
  }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 20
  condition {
    host_header { values = [var.app_domain] }
  }
  condition {
    path_pattern { values = ["/api/v1/*"] }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["api"].arn
  }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 30
  condition {
    host_header { values = [var.app_domain] }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc["web"].arn
  }
}

resource "aws_wafv2_ip_set" "admin" {
  name               = "${var.name}-admin-allowlist"
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = var.admin_ip_allowlist
}

resource "aws_wafv2_web_acl" "this" {
  name  = var.name
  scope = "REGIONAL"
  default_action {
    allow {}
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000 # requests per 5 minutes per IP
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "rate-limit"
      sampled_requests_enabled   = true
    }
  }

  dynamic "rule" {
    for_each = {
      AWSManagedRulesAmazonIpReputationList = 10
      AWSManagedRulesCommonRuleSet          = 20
      AWSManagedRulesSQLiRuleSet            = 40
    }
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          vendor_name = "AWS"
          name        = rule.key
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  # Includes the Log4j (CVE-2021-44228) signatures.
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 30
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

resource "aws_cloudwatch_log_group" "waf" {
  name              = "aws-waf-logs-${var.name}"
  retention_in_days = 365
  kms_key_id        = var.logs_kms_key_arn
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  redacted_fields {
    single_header { name = "cookie" }
  }
  redacted_fields {
    single_header { name = "authorization" }
  }
}

# ------------------------------------------------------------------ ECS

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each          = toset(["api", "worker", "web", "keycloak", "migrate"])
  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = 365
  kms_key_id        = var.logs_kms_key_arn
}

locals {
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "TRUST_PROXY", value = "true" },
    { name = "PUBLIC_WEB_ORIGIN", value = "https://${var.app_domain}" },
    { name = "API_BASE_URL", value = "https://${var.app_domain}/api/v1" },
    { name = "OIDC_ISSUER", value = "https://${var.auth_domain}/realms/pmo" },
    { name = "OIDC_CLIENT_ID", value = "leasing-staff" },
    { name = "KEYCLOAK_ADMIN_CLIENT_ID", value = "leasing-admin" },
    { name = "KMS_KEY_ID", value = var.app_kms_key_arn },
    { name = "S3_REGION", value = data.aws_region.current.name },
    { name = "S3_BUCKET", value = var.documents_bucket },
    { name = "S3_AUDIT_BUCKET", value = var.audit_bucket },
    { name = "S3_SSE_KMS_KEY_ID", value = var.data_kms_key_arn },
    { name = "COOKIE_SECURE", value = "true" },
  ]
  secret = { for k, arn in var.secret_arns : k => arn }
  log_config = { for svc, g in aws_cloudwatch_log_group.svc : svc => {
    logDriver = "awslogs"
    options   = { "awslogs-group" = g.name, "awslogs-region" = data.aws_region.current.name, "awslogs-stream-prefix" = svc }
  } }
  node_hardening = {
    readonlyRootFilesystem = true
    user                   = "1000:1000"
    linuxParameters        = { initProcessEnabled = true, capabilities = { drop = ["ALL"] } }
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp" }]
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  task_role_arn            = var.task_role_arns["api"]
  execution_role_arn       = var.execution_role_arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  volume { name = "tmp" }
  container_definitions = jsonencode([merge(local.node_hardening, {
    name         = "api"
    image        = var.images["api"]
    essential    = true
    portMappings = [{ containerPort = 4000 }]
    environment  = concat(local.common_env, [{ name = "PORT", value = "4000" }])
    secrets = [
      { name = "DATABASE_URL_APP", valueFrom = local.secret["database_url_app"] },
      { name = "REDIS_URL", valueFrom = local.secret["redis_url"] },
      { name = "OIDC_CLIENT_SECRET", valueFrom = local.secret["oidc_client_secret"] },
      { name = "KEYCLOAK_ADMIN_CLIENT_SECRET", valueFrom = local.secret["keycloak_admin_client_secret"] },
      { name = "IP_HASH_KEY", valueFrom = local.secret["ip_hash_key"] },
    ]
    logConfiguration = local.log_config["api"]
  })])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 3072 # ClamAV loads ~1.5 GB of signatures
  task_role_arn            = var.task_role_arns["worker"]
  execution_role_arn       = var.execution_role_arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  volume { name = "tmp" }
  container_definitions = jsonencode([
    merge(local.node_hardening, {
      name        = "worker"
      image       = var.images["worker"]
      essential   = true
      environment = concat(local.common_env, [{ name = "CLAMD_HOST", value = "localhost" }, { name = "CLAMD_PORT", value = "3310" }])
      secrets = [
        { name = "DATABASE_URL_WORKER", valueFrom = local.secret["database_url_worker"] },
        { name = "REDIS_URL", valueFrom = local.secret["redis_url"] },
      ]
      dependsOn        = [{ containerName = "clamav", condition = "HEALTHY" }]
      logConfiguration = local.log_config["worker"]
    }),
    {
      # ClamAV sidecar: reachable only on localhost inside the task.
      name             = "clamav"
      image            = var.images["clamav"]
      essential        = true
      healthCheck      = { command = ["CMD-SHELL", "clamdcheck.sh"], interval = 30, startPeriod = 180, retries = 3 }
      logConfiguration = local.log_config["worker"]
    },
  ])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  task_role_arn            = var.task_role_arns["web"]
  execution_role_arn       = var.execution_role_arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  volume { name = "tmp" }
  volume { name = "next-cache" } # Next.js writes its cache here; the root filesystem stays read-only
  container_definitions = jsonencode([merge(local.node_hardening, {
    name      = "web"
    image     = var.images["web"]
    essential = true
    mountPoints = [
      { sourceVolume = "tmp", containerPath = "/tmp" },
      { sourceVolume = "next-cache", containerPath = "/app/apps/web/.next/cache" },
    ]
    portMappings = [{ containerPort = 3000 }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "UPLOAD_ORIGIN", value = "https://${var.documents_bucket}.s3.${data.aws_region.current.name}.amazonaws.com" },
      { name = "API_INTERNAL_URL", value = "https://${var.app_domain}" },
    ]
    logConfiguration = local.log_config["web"]
  })])
}

resource "aws_ecs_task_definition" "keycloak" {
  family                   = "${var.name}-keycloak"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  task_role_arn            = var.task_role_arns["keycloak"]
  execution_role_arn       = var.execution_role_arn
  container_definitions = jsonencode([{
    name         = "keycloak"
    image        = var.images["keycloak"]
    essential    = true
    command      = ["start", "--optimized", "--import-realm"]
    portMappings = [{ containerPort = 8080 }]
    environment = [
      { name = "KC_HOSTNAME", value = "https://${var.auth_domain}" },
      { name = "KC_PROXY_HEADERS", value = "xforwarded" },
      { name = "KC_HTTP_ENABLED", value = "true" },
      { name = "KC_HEALTH_ENABLED", value = "true" },
      { name = "WEB_ORIGIN", value = "https://${var.app_domain}" },
    ]
    secrets = [
      { name = "KC_DB_URL", valueFrom = local.secret["keycloak_db_url"] },
      { name = "KC_DB_PASSWORD", valueFrom = local.secret["keycloak_db_password"] },
      { name = "KC_BOOTSTRAP_ADMIN_PASSWORD", valueFrom = local.secret["keycloak_admin_password"] },
      { name = "LEASING_CLIENT_SECRET", valueFrom = local.secret["oidc_client_secret"] },
      { name = "LEASING_ADMIN_CLIENT_SECRET", valueFrom = local.secret["keycloak_admin_client_secret"] },
      { name = "GOOGLE_CLIENT_ID", valueFrom = local.secret["google_client_id"] },
      { name = "GOOGLE_CLIENT_SECRET", valueFrom = local.secret["google_client_secret"] },
      { name = "GOOGLE_HOSTED_DOMAIN", valueFrom = local.secret["google_hosted_domain"] },
    ]
    logConfiguration = local.log_config["keycloak"]
  }])
}

# One-off task: `aws ecs run-task --task-definition <name>-migrate` before each deploy.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  task_role_arn            = var.task_role_arns["migrate"]
  execution_role_arn       = var.execution_role_arn
  volume { name = "tmp" }
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([merge(local.node_hardening, {
    name             = "migrate"
    image            = var.images["api"]
    essential        = true
    command          = ["node", "node_modules/@crm/db/dist/cli/migrate.js"]
    secrets          = [{ name = "DATABASE_URL_MIGRATOR", valueFrom = local.secret["database_url_migrator"] }]
    logConfiguration = local.log_config["migrate"]
  })])
}

locals {
  services = {
    api      = { td = aws_ecs_task_definition.api.arn, lb = true, port = 4000, count = var.desired_count }
    web      = { td = aws_ecs_task_definition.web.arn, lb = true, port = 3000, count = var.desired_count }
    keycloak = { td = aws_ecs_task_definition.keycloak.arn, lb = true, port = 8080, count = var.desired_count }
    worker   = { td = aws_ecs_task_definition.worker.arn, lb = false, port = 0, count = 1 }
  }
}

resource "aws_ecs_service" "svc" {
  for_each               = local.services
  name                   = each.key
  cluster                = aws_ecs_cluster.this.id
  task_definition        = each.value.td
  desired_count          = each.value.count
  launch_type            = "FARGATE"
  enable_execute_command = false # no shell access into production tasks
  propagate_tags         = "SERVICE"
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.tasks_security_group_id]
    assign_public_ip = false
  }
  dynamic "load_balancer" {
    for_each = each.value.lb ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.svc[each.key].arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

# ------------------------------------------------------------------ task permissions

resource "aws_iam_role_policy" "api" {
  role = var.task_role_names["api"]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Documents", Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], Resource = ["${var.documents_bucket_arn}/quarantine/*", "${var.documents_bucket_arn}/clean/*"] },
      { Sid = "DocumentsHead", Effect = "Allow", Action = ["s3:ListBucket"], Resource = var.documents_bucket_arn },
      { Sid = "EnvelopeKek", Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt"], Resource = var.app_kms_key_arn },
      { Sid = "SseKms", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = var.data_kms_key_arn },
    ]
  })
}

resource "aws_iam_role_policy" "worker" {
  role = var.task_role_names["worker"]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Documents", Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = ["${var.documents_bucket_arn}/quarantine/*", "${var.documents_bucket_arn}/clean/*"] },
      # Write-only to the audit archive: the worker can add objects but never read/delete them.
      { Sid = "AuditArchive", Effect = "Allow", Action = ["s3:PutObject"], Resource = "${var.audit_bucket_arn}/audit/*" },
      { Sid = "EnvelopeKek", Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt"], Resource = var.app_kms_key_arn },
      { Sid = "SseKms", Effect = "Allow", Action = ["kms:GenerateDataKey", "kms:Decrypt"], Resource = [var.data_kms_key_arn, var.logs_kms_key_arn] },
    ]
  })
}

resource "aws_iam_role_policy" "execution_secrets" {
  role = var.execution_role_name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = values(var.secret_arns) },
      { Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.data_kms_key_arn },
    ]
  })
}

output "alb_dns_name" { value = aws_lb.this.dns_name }
output "alb_zone_id" { value = aws_lb.this.zone_id }
output "cluster_name" { value = aws_ecs_cluster.this.name }
