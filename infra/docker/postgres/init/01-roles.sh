#!/usr/bin/env bash
# Creates the database and the least-privilege login roles (ADR-003).
#
#   app_migrator  owns all objects, runs migrations. Never used by the running app.
#   app_rw        the API's runtime role. Not an owner, NOBYPASSRLS → every row goes through RLS.
#   app_worker    the background worker's runtime role. Also NOBYPASSRLS; a few policies
#                 grant it system-only actions (scan results, key rotation, audit shipping).
#
# In production these roles are created by Terraform/ops with passwords from Secrets Manager.
set -euo pipefail

: "${APP_DB_NAME:=leasing}"
: "${APP_MIGRATOR_PASSWORD:?set APP_MIGRATOR_PASSWORD}"
: "${APP_RW_PASSWORD:?set APP_RW_PASSWORD}"
: "${APP_WORKER_PASSWORD:?set APP_WORKER_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v db="$APP_DB_NAME" -v mig_pw="$APP_MIGRATOR_PASSWORD" -v rw_pw="$APP_RW_PASSWORD" -v wk_pw="$APP_WORKER_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE app_migrator LOGIN PASSWORD %L NOSUPERUSER NOCREATEROLE NOCREATEDB', :'mig_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') \gexec
SELECT format('CREATE ROLE app_rw LOGIN PASSWORD %L NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS', :'rw_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') \gexec
SELECT format('CREATE ROLE app_worker LOGIN PASSWORD %L NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS', :'wk_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') \gexec
SELECT format('CREATE DATABASE %I OWNER app_migrator', :'db')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL

# Extensions need superuser; create them once so app_migrator never needs elevated rights.
psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "$APP_DB_NAME" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CREATE, USAGE ON SCHEMA public TO app_migrator;
SQL

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "$APP_DB_NAME" -v db="$APP_DB_NAME" <<'SQL'
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO app_rw, app_worker', :'db') \gexec
SQL
