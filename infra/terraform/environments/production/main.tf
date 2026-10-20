terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.80" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {}
}

provider "aws" {
  region = "ap-southeast-1" # Singapore
  default_tags {
    tags = { Project = "leasing-crm", Environment = "production", ManagedBy = "terraform", DataClassification = "confidential" }
  }
}

provider "aws" {
  alias  = "backup"
  region = var.backup_region
  default_tags {
    tags = { Project = "leasing-crm", Environment = "production", ManagedBy = "terraform", Purpose = "dr-backup" }
  }
}

variable "backup_region" {
  type    = string
  default = "ap-southeast-3" # Jakarta [CONFIRM DR region]
}
variable "app_domain" { type = string }
variable "auth_domain" { type = string }
variable "certificate_arn" { type = string }
variable "images" { type = map(string) }
variable "admin_ip_allowlist" { type = list(string) }

module "stack" {
  source    = "../../modules/stack"
  providers = { aws = aws, aws.backup = aws.backup }

  name               = "leasing-prod"
  vpc_cidr           = "10.50.0.0/16"
  azs                = ["ap-southeast-1a", "ap-southeast-1b", "ap-southeast-1c"]
  app_domain         = var.app_domain
  auth_domain        = var.auth_domain
  certificate_arn    = var.certificate_arn
  images             = var.images
  db_instance_class  = "db.r7g.large"
  multi_az           = true
  desired_count      = 2
  admin_ip_allowlist = var.admin_ip_allowlist
  # [CONFIRM retention periods] — placeholder: 10 years for the audit archive.
  audit_retention_days = 3650
}

output "alb_dns_name" { value = module.stack.alb_dns_name }
