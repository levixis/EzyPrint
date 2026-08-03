#!/usr/bin/env bash
#
# Run a command against the PRODUCTION database, on purpose.
#
#   I_MEAN_PRODUCTION=1 ./scripts/with-production.sh npx prisma migrate status
#
# Everything else — `npm run dev`, plain `npx prisma …`, every ad-hoc script —
# uses server/.env, which points at the Neon `dev` branch. That is the default
# precisely because it used to be production: a `migrate diff` aimed at the
# connection string in .env emptied every table in the live database, and the
# command looked read-only right up until it wasn't.
#
# This exists so reaching production is a sentence you have to type, not a
# thing that happens because a file happened to contain a URL.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env.production.local ]; then
  echo "error: .env.production.local is missing — nothing to connect to." >&2
  exit 1
fi

if [ "${I_MEAN_PRODUCTION:-}" != "1" ]; then
  cat >&2 <<'MSG'
Refusing to touch production without an explicit opt-in.

  I_MEAN_PRODUCTION=1 ./scripts/with-production.sh <command>

Before you do: this is live student orders, shop balances and payout records.
Reads are fine. If the command writes, migrates, resets, pushes a schema, or
carries --shadow-database-url, use the dev branch instead — it is a full copy
and nothing depends on it.
MSG
  exit 1
fi

if [ $# -eq 0 ]; then
  echo "error: nothing to run." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env.production.local
set +a

echo "▸ PRODUCTION — $*" >&2
exec "$@"
