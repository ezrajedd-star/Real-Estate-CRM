# One task role per service (least privilege; permissions are attached in modules/app once
# the resources they refer to exist) plus a shared execution role for pulling images and
# reading the service's own secrets.

variable "name" { type = string }
variable "services" {
  type    = list(string)
  default = ["api", "worker", "web", "keycloak", "migrate"]
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task" {
  for_each           = toset(var.services)
  name               = "${var.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

output "task_role_arns" { value = { for k, r in aws_iam_role.task : k => r.arn } }
output "task_role_names" { value = { for k, r in aws_iam_role.task : k => r.name } }
output "execution_role_arn" { value = aws_iam_role.execution.arn }
output "execution_role_name" { value = aws_iam_role.execution.name }
