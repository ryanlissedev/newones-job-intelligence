#!/bin/sh
set -eu

mc alias set local "http://minio:9000" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
mc mb --ignore-existing "local/${WALG_S3_BUCKET}"

# CI/local fixture only: production buckets use provider-managed default encryption.
echo "minio-init: bucket ${WALG_S3_BUCKET} ready"
