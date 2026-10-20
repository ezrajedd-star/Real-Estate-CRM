#!/bin/sh
# Mirrors the production bucket layout (ADR-006, ADR-004) in local MinIO.
set -eu
mc alias set local http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"

# Private documents bucket: no public access, versioning on.
mc mb --ignore-existing local/leasing-documents
mc anonymous set none local/leasing-documents
mc version enable local/leasing-documents
mc cors set local/leasing-documents /init/cors.json

# Write-once audit bucket: Object Lock (compliance) — objects cannot be deleted or overwritten
# before retention expires, even by the root user.
if ! mc stat local/leasing-audit >/dev/null 2>&1; then
  mc mb --with-lock local/leasing-audit
fi
mc retention set --default compliance 400d local/leasing-audit
mc anonymous set none local/leasing-audit
echo "buckets ready"
