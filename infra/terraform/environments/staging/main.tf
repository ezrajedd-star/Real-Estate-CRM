terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.80" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # State: encrypted S3 bucket with DynamoDB locking, in a separate security account.
  # Fill in via `terraform init -backend-config=backend.hcl` (not committed).
  backend "s3" {}
}

provider "aws" {
  region = "ap-southeast-1" # Singapore
  default_tags {
    tags = { Project = "leasing-crm", Environment = "staging", ManagedBy = "terraform", DataClassification = "confidential" }
  }
}

provider "aws" {
  alias  = "backup"
  region = var.backup_region
  default_tags {
    tags = { Project = "leasing-crm", Environment = "staging", ManagedBy = "terraform", Purpose = "dr-backup" }
  }
}

variable "backup_region" {
  type        = string
  default     = "ap-southeast-3" # Jakarta [CONFIRM DR region]
  description = "Region for cross-region backup copies"
}
variable "app_domain" { type = string }
variable "auth_domain" { type = string }
variable "certificate_arn" { type = string }
variable "images" {
  type        = map(string)
  description = "Image references pinned by digest: api, worker, web, keycloak, clamav"
}
variable "admin_ip_allowlist" {
  type    = list(string)
  default = []
}

module "stack" {
  source    = "../../modules/stack"
  providers = { aws = aws, aws.backup = aws.backup }

  name                 = "leasing-staging"
  vpc_cidr             = "10.40.0.0/16"
  azs                  = ["ap-southeast-1a", "ap-southeast-1b"]
  app_domain           = var.app_domain
  auth_domain          = var.auth_domain
  certificate_arn      = var.certificate_arn
  images               = var.images
  db_instance_class    = "db.t4g.medium"
  multi_az             = false
  desired_count        = 1
  admin_ip_allowlist   = var.admin_ip_allowlist
  audit_retention_days = 90
}

output "alb_dns_name" { value = module.stack.alb_dns_name }
