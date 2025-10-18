#!/bin/sh
# wait-for-db.sh

set -e

host="$DB_HOST"
port="$DB_PORT"

echo "Waiting for Postgres to be ready at $host:$port..."

until nc -z "$host" "$port"; do
  echo "Postgres is unavailable - sleeping"
  sleep 2
done

echo "Postgres is up! Running database schema..."
node scripts/runSchema.js
echo "Starting backend server..."

