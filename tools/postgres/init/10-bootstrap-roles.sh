#!/usr/bin/env bash
set -Eeuo pipefail

readonly role_pattern='^[a-zA-Z_][a-zA-Z0-9_]*$'

require_value() {
  local variable_name="$1"
  local variable_value="${!variable_name:-}"

  if [[ -z "$variable_value" ]]; then
    echo "postgres init: $variable_name must not be empty" >&2
    exit 1
  fi

  if [[ "$variable_value" == *$'\n'* || "$variable_value" == *$'\r'* ]]; then
    echo "postgres init: $variable_name must not contain newlines" >&2
    exit 1
  fi
}

validate_role_name() {
  local variable_name="$1"
  local role_name="${!variable_name}"

  if [[ ! "$role_name" =~ $role_pattern ]]; then
    echo "postgres init: $variable_name must be a PostgreSQL identifier" >&2
    exit 1
  fi
}

for variable_name in \
  POSTGRES_USER \
  POSTGRES_DB \
  POSTGRES_MIGRATOR_USER \
  POSTGRES_MIGRATOR_PASSWORD \
  POSTGRES_APP_USER \
  POSTGRES_APP_PASSWORD; do
  require_value "$variable_name"
done

for variable_name in \
  POSTGRES_USER \
  POSTGRES_MIGRATOR_USER \
  POSTGRES_APP_USER; do
  validate_role_name "$variable_name"
done

if [[ "$POSTGRES_USER" == "$POSTGRES_MIGRATOR_USER" || \
  "$POSTGRES_USER" == "$POSTGRES_APP_USER" || \
  "$POSTGRES_MIGRATOR_USER" == "$POSTGRES_APP_USER" ]]; then
  echo "postgres init: admin, migrator, and app roles must be distinct" >&2
  exit 1
fi

psql \
  --dbname "$POSTGRES_DB" \
  --set ON_ERROR_STOP=1 \
  --set migrator_password="$POSTGRES_MIGRATOR_PASSWORD" \
  --set migrator_user="$POSTGRES_MIGRATOR_USER" \
  --set app_password="$POSTGRES_APP_PASSWORD" \
  --set app_user="$POSTGRES_APP_USER" \
  --username "$POSTGRES_USER" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'migrator_user'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'migrator_user')
\gexec

SELECT format('ALTER ROLE %I PASSWORD %L', :'migrator_user', :'migrator_password')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'app_user'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format('ALTER ROLE %I PASSWORD %L', :'app_user', :'app_password')
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database())
\gexec
SELECT format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', current_database(), :'migrator_user')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user')
\gexec

REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'migrator_user')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user')
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE ON SCHEMAS TO %I',
  :'migrator_user',
  :'app_user'
)
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'migrator_user',
  :'app_user'
)
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
  :'migrator_user',
  :'app_user'
)
\gexec
SQL

echo "postgres init: least-privilege migrator and app roles created"
