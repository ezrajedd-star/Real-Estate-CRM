# One complete environment: network → IAM → KMS → data stores → app, plus cross-region
# backup copies. Called by environments/<env>/main.tf.

terraform {
  required_providers {
    aws = {
      source                = "hashicorp/aws"
      configuration_aliases = [aws.backup]
    }
    random = { source = "hashicorp/random" }
  }
}

variable "name" { type = string }
variable "vpc_cidr" { type = string }
variable "azs" { type = list(string) }
variable "app_domain" { type = string }
variable "auth_domain" { type = string }
variable "certificate_arn" { type = string }
variable "images" { type = map(string) }
variable "db_instance_class" { type = string }
variable "multi_az" { type = bool }
variable "desired_count" { type = number }
variable "admin_ip_allowlist" { type = list(string) }
variable "audit_retention_days" { type = number }

module "network" {
  source          = "../network"
  name            = var.name
  cidr            = var.vpc_cidr
  azs             = var.azs
  log_kms_key_arn = module.kms.logs_key_arn
}

module "iam" {
  source = "../iam"
  name   = var.name
}

module "kms" {
  source             = "../kms"
  name               = var.name
  app_task_role_arns = [module.iam.task_role_arns["api"], module.iam.task_role_arns["worker"]]
}

# ------------------------------------------------------------------ backup region

resource "aws_kms_key" "backup" {
  provider                = aws.backup
  description             = "${var.name} cross-region backups"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "KeyAdministration"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
}

resource "aws_s3_bucket_lifecycle_configuration" "backup_documents" {
  provider = aws.backup
  bucket   = aws_s3_bucket.backup_documents.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
    noncurrent_version_expiration { noncurrent_days = 90 }
  }
}

resource "aws_s3_bucket" "backup_documents" {
  provider = aws.backup
  bucket   = "${var.name}-documents-replica"
}

resource "aws_s3_bucket_versioning" "backup_documents" {
  provider = aws.backup
  bucket   = aws_s3_bucket.backup_documents.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "backup_documents" {
  provider                = aws.backup
  bucket                  = aws_s3_bucket.backup_documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup_documents" {
  provider = aws.backup
  bucket   = aws_s3_bucket.backup_documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backup.arn
    }
  }
}

module "data" {
  source                   = "../data"
  name                     = var.name
  vpc_id                   = module.network.vpc_id
  private_subnet_ids       = module.network.private_subnet_ids
  app_security_group_id    = module.network.tasks_security_group_id
  data_kms_key_arn         = module.kms.data_key_arn
  logs_kms_key_arn         = module.kms.logs_key_arn
  web_origin               = "https://${var.app_domain}"
  db_instance_class        = var.db_instance_class
  multi_az                 = var.multi_az
  backup_region_bucket_arn = aws_s3_bucket.backup_documents.arn
  audit_retention_days     = var.audit_retention_days
}

# Point-in-time-restorable RDS backups replicated to the backup region (DR, RTO ≤ 4 h target).
resource "aws_db_instance_automated_backups_replication" "this" {
  provider               = aws.backup
  source_db_instance_arn = "arn:aws:rds:${data.aws_region.primary.name}:${data.aws_caller_identity.current.account_id}:db:${var.name}"
  kms_key_id             = aws_kms_key.backup.arn
  retention_period       = 14
  depends_on             = [module.data]
}

data "aws_region" "primary" {}
data "aws_caller_identity" "current" {}

# ------------------------------------------------------------------ secrets (values set out-of-band)
# Terraform creates the containers only; operators set values via the console/CLI so that
# secret values never enter Terraform state.

locals {
  secret_names = [
    "database_url_app",
    "database_url_worker",
    "database_url_migrator",
    "redis_url",
    "oidc_client_secret",
    "keycloak_admin_client_secret",
    "keycloak_db_url",
    "keycloak_db_password",
    "keycloak_admin_password",
    "ip_hash_key",
    "google_client_id",
    "google_client_secret",
    "google_hosted_domain",
  ]
}

resource "aws_secretsmanager_secret" "app" {
  for_each   = toset(local.secret_names)
  name       = "${var.name}/${each.key}"
  kms_key_id = module.kms.data_key_arn
}

module "app" {
  source                  = "../app"
  name                    = var.name
  vpc_id                  = module.network.vpc_id
  public_subnet_ids       = module.network.public_subnet_ids
  private_subnet_ids      = module.network.private_subnet_ids
  alb_security_group_id   = module.network.alb_security_group_id
  tasks_security_group_id = module.network.tasks_security_group_id
  app_domain              = var.app_domain
  auth_domain             = var.auth_domain
  certificate_arn         = var.certificate_arn
  images                  = var.images
  task_role_arns          = module.iam.task_role_arns
  task_role_names         = module.iam.task_role_names
  execution_role_arn      = module.iam.execution_role_arn
  execution_role_name     = module.iam.execution_role_name
  app_kms_key_arn         = module.kms.app_key_arn
  data_kms_key_arn        = module.kms.data_key_arn
  logs_kms_key_arn        = module.kms.logs_key_arn
  documents_bucket        = module.data.documents_bucket
  documents_bucket_arn    = module.data.documents_bucket_arn
  audit_bucket            = module.data.audit_bucket
  audit_bucket_arn        = module.data.audit_bucket_arn
  logs_bucket             = module.data.logs_bucket
  secret_arns             = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
  admin_ip_allowlist      = var.admin_ip_allowlist
  desired_count           = var.desired_count
}

output "alb_dns_name" { value = module.app.alb_dns_name }
output "db_endpoint" { value = module.data.db_endpoint }
output "documents_bucket" { value = module.data.documents_bucket }
output "audit_bucket" { value = module.data.audit_bucket }
