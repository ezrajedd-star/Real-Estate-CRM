#!/usr/bin/env bash
# Drops and recreates the LOCAL dev/test database, then migrates it. Refuses anything that
# is not localhost. Never point this at a shared environment.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${APP_DB_NAME:=leasing}"
: "${PGHOST:=localhost}"
if [[ "$PGHOST" != "localhost" && "$PGHOST" != "127.0.0.1" ]]; then
  echo "Refusing to reset a non-local database ($PGHOST)" >&2
  exit 1
fi
export APP_MIGRATOR_PASSWORD="${APP_MIGRATOR_PASSWORD:-migrator_dev}"
export APP_RW_PASSWORD="${APP_RW_PASSWORD:-rw_dev}"
export APP_WORKER_PASSWORD="${APP_WORKER_PASSWORD:-worker_dev}"

PSQL_SUPER=(psql -v ON_ERROR_STOP=1 -h "$PGHOST" -U "${POSTGRES_USER:-postgres}")
"${PSQL_SUPER[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${APP_DB_NAME} WITH (FORCE)"
POSTGRES_USER="${POSTGRES_USER:-postgres}" PGHOST="$PGHOST" bash infra/docker/postgres/init/01-roles.sh
DATABASE_URL_MIGRATOR="postgres://app_migrator:${APP_MIGRATOR_PASSWORD}@${PGHOST}:5432/${APP_DB_NAME}" pnpm db:migrate
