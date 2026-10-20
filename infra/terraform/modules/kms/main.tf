# Customer-managed KMS keys, one per purpose, all with automatic annual rotation.
#   app  — KEK for application envelope encryption (TINs, IDs, bank, financials)
#   data — RDS, ElastiCache, S3 documents and backups
#   logs — CloudWatch Logs and the audit bucket

variable "name" { type = string }
variable "app_task_role_arns" {
  type        = list(string)
  description = "Roles allowed to wrap/unwrap data keys with the app KEK (API and worker tasks)"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  root = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
}

resource "aws_kms_key" "app" {
  description             = "${var.name} application envelope-encryption KEK"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "KeyAdministration", Effect = "Allow", Principal = { AWS = local.root }, Action = "kms:*", Resource = "*" },
      {
        # Only the API and worker task roles may use the KEK, and only with an encryption
        # context naming a purpose (enforced by the app: { purpose, version }).
        Sid       = "AppUse"
        Effect    = "Allow"
        Principal = { AWS = var.app_task_role_arns }
        Action    = ["kms:Encrypt", "kms:Decrypt"]
        Resource  = "*"
        Condition = { "ForAnyValue:StringLike" = { "kms:EncryptionContextKeys" = ["purpose"] } }
      },
    ]
  })
}

resource "aws_kms_alias" "app" {
  name          = "alias/${var.name}-app"
  target_key_id = aws_kms_key.app.key_id
}

resource "aws_kms_key" "data" {
  description             = "${var.name} data at rest (RDS, Redis, S3, backups)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  # Account-administered; services and task roles get access through IAM policies.
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "KeyAdministration", Effect = "Allow", Principal = { AWS = local.root }, Action = "kms:*", Resource = "*" }]
  })
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "logs" {
  description             = "${var.name} logs and audit archive"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "KeyAdministration", Effect = "Allow", Principal = { AWS = local.root }, Action = "kms:*", Resource = "*" },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${data.aws_region.current.name}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.name}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

output "app_key_arn" { value = aws_kms_key.app.arn }
output "data_key_arn" { value = aws_kms_key.data.arn }
output "logs_key_arn" { value = aws_kms_key.logs.arn }
