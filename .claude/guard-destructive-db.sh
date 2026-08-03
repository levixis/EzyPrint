#!/usr/bin/env bash
#
# Refuse commands that can destroy a database, before they run.
#
# Written after a `prisma migrate diff --shadow-database-url "$PRODUCTION_URL"`
# emptied every table in production. A *shadow database* is scratch space that
# Prisma resets and replays all migrations into; pointing it at a live database
# is not a diff, it is a wipe. The command looked read-only, was named "diff",
# and printed "This is an empty migration" while the data was already gone.
#
# Permission rules alone were not enough for this:
#   - `.claude/settings.local.json` allows `Bash(npx prisma *)` wholesale
#   - rules match on a prefix, and the command began `cd "…/server" && npx …`,
#     so nothing anchored on `npx prisma` would have matched it either
#
# This inspects the whole command string wherever the dangerous part appears.
#
# Exits 0 always. A hook that errors is a hook that gets disabled; refusal is
# expressed through the JSON decision, not the exit code.

set -uo pipefail

cmd="$(jq -r '.tool_input.command // ""' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

# Commands that cannot reach a database, but routinely *quote* things that can.
#
# A `git commit` whose message describes this very incident contains the literal
# string --shadow-database-url, and the first version of this guard refused it.
# A safeguard that blocks writing about the accident it prevents is one that
# gets switched off, so the leading executable is checked first.
#
# `cd … &&` prefixes are stripped, because that is how most commands here are
# written and the dangerous ones hid behind exactly that.
effective="$cmd"
while [[ "$effective" =~ ^[[:space:]]*cd[[:space:]]+[^\&\;]+[\&\;]+[[:space:]]*(.*)$ ]]; do
  effective="${BASH_REMATCH[1]}"
done

case "$effective" in
  git\ *|echo\ *|cat\ *|printf\ *|jq\ *|grep\ *|rg\ *|sed\ *|less\ *|head\ *|tail\ *)
    exit 0
    ;;
esac

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# ── Prisma ───────────────────────────────────────────────────────────────────

# The one that actually happened. Prisma resets whatever this points at.
if grep -qE -- '--shadow-database-url' <<<"$cmd"; then
  deny "Blocked: --shadow-database-url. Prisma RESETS the database this points at and replays every migration into it. This wiped production once. To validate a migration, apply it inside a transaction you roll back, or create a throwaway Neon branch and point DATABASE_URL there."
fi

# Drops and recreates the database.
if grep -qE 'prisma[[:space:]]+migrate[[:space:]]+reset' <<<"$cmd"; then
  deny "Blocked: 'prisma migrate reset' drops every table and re-seeds. If you genuinely want this, run it yourself against a database you have confirmed is not production."
fi

# Silently drops columns and tables to force the schema into shape.
if grep -qE 'prisma[[:space:]]+db[[:space:]]+push' <<<"$cmd"; then
  deny "Blocked: 'prisma db push' alters the schema without a migration and will drop columns or tables to make it fit. Write a migration instead."
fi

# Creates and resets a shadow database as part of its normal operation.
if grep -qE 'prisma[[:space:]]+migrate[[:space:]]+dev' <<<"$cmd"; then
  deny "Blocked: 'prisma migrate dev' provisions and resets a shadow database. Safe only against local scratch databases — and this project's .env points at Neon production. Write the migration SQL by hand and apply it with 'migrate deploy'."
fi

# ── Raw SQL ──────────────────────────────────────────────────────────────────

if grep -qiE '\b(DROP|TRUNCATE)[[:space:]]+(TABLE|DATABASE|SCHEMA)\b' <<<"$cmd"; then
  deny "Blocked: DROP/TRUNCATE of a table, schema or database. If this is intentional cleanup, run it yourself after confirming which database you are connected to."
fi

# `deleteMany()` / `deleteMany({})` — no filter means every row.
if grep -qE 'deleteMany\([[:space:]]*(\{[[:space:]]*\})?[[:space:]]*\)' <<<"$cmd"; then
  deny "Blocked: an unfiltered deleteMany() removes every row in the table. Add a where clause, or run it yourself if you mean it."
fi

exit 0
