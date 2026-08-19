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
# A heredoc body is text being *written*, not a command being run.
#
# The header above explains why a commit message describing this incident must
# not be refused by the guard that prevents it — and the `cd` stripping below
# was the fix for that. It was not enough. This very file gets committed with a
# message explaining what it does, through a pipeline like
#
#     tr ... | xargs -0 git commit -F - -- <<'MSG'
#
# whose leading executable is `tr`, so the git allowlist never matches, and the
# prose in the heredoc trips every pattern below. A guard that blocks you from
# describing the accident is a guard that gets deleted.
#
# So: pattern-match against the command with heredoc bodies removed. This is a
# speed bump against accidents, not a sandbox — someone determined to run
# something dangerous has a hundred routes, and none of them are "explain it in
# a commit message first".
scan="$(printf '%s\n' "$cmd" | awk '
  BEGIN { skip = 0; marker = "" }
  {
    if (skip) { if ($0 == marker || $0 == marker"\r") { skip = 0 }; next }
    line = $0
    if (match(line, /<<-?[ \t]*'"'"'?[A-Za-z_][A-Za-z0-9_]*'"'"'?/)) {
      m = substr(line, RSTART, RLENGTH)
      sub(/^<<-?[ \t]*/, "", m)
      gsub(/'"'"'/, "", m)
      gsub(/"/, "", m)
      marker = m; skip = 1
    }
    print line
  }')"

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
if grep -qE -- '--shadow-database-url' <<<"$scan"; then
  deny "Blocked: --shadow-database-url. Prisma RESETS the database this points at and replays every migration into it. This wiped production once. To validate a migration, apply it inside a transaction you roll back, or create a throwaway Neon branch and point DATABASE_URL there."
fi

# Drops and recreates the database.
if grep -qE 'prisma[[:space:]]+migrate[[:space:]]+reset' <<<"$scan"; then
  deny "Blocked: 'prisma migrate reset' drops every table and re-seeds. If you genuinely want this, run it yourself against a database you have confirmed is not production."
fi

# Silently drops columns and tables to force the schema into shape.
if grep -qE 'prisma[[:space:]]+db[[:space:]]+push' <<<"$scan"; then
  deny "Blocked: 'prisma db push' alters the schema without a migration and will drop columns or tables to make it fit. Write a migration instead."
fi

# Creates and resets a shadow database as part of its normal operation.
if grep -qE 'prisma[[:space:]]+migrate[[:space:]]+dev' <<<"$scan"; then
  deny "Blocked: 'prisma migrate dev' provisions and resets a shadow database. Safe only against local scratch databases — and this project's .env points at Neon production. Write the migration SQL by hand and apply it with 'migrate deploy'."
fi

# ── Which database is `prisma migrate` actually going to touch? ───────────────
#
# Written after `DATABASE_URL=<localhost> npx prisma migrate deploy` applied two
# pending migrations to Neon production. The command looked explicitly scoped and
# was not: schema.prisma sets
#
#     url       = env("DATABASE_URL")   # pooled, runtime
#     directUrl = env("DIRECT_URL")     # migrations
#
# so `migrate` reads DIRECT_URL, which was never overridden and came from .env —
# production. Overriding one variable and not the other reads as safe and is not,
# and nothing in the output has to be read for the command to succeed.
#
# So: any `prisma migrate` must name BOTH variables inline, and if the one that
# migrations actually use does not point at localhost, it must say so on purpose.
if grep -qE 'prisma[[:space:]]+migrate' <<<"$scan"; then

  has_database_url=false
  has_direct_url=false
  grep -qE '(^|[[:space:]])DATABASE_URL=' <<<"$scan" && has_database_url=true
  grep -qE '(^|[[:space:]])DIRECT_URL='   <<<"$scan" && has_direct_url=true

  if [ "$has_database_url" = false ] || [ "$has_direct_url" = false ]; then
    missing=""
    [ "$has_database_url" = false ] && missing="DATABASE_URL"
    [ "$has_direct_url"   = false ] && missing="${missing:+$missing and }DIRECT_URL"
    deny "Blocked: 'prisma migrate' without $missing set inline on the command.

schema.prisma uses env(\"DATABASE_URL\") for the pooled runtime connection and env(\"DIRECT_URL\") for migrations. Anything you do not set here is read from server/.env, which points at Neon PRODUCTION — that is how a migrate meant for localhost was applied to production.

Set both, every time:
  DATABASE_URL='postgresql://localhost:5432/<db>' DIRECT_URL='postgresql://localhost:5432/<db>' npx prisma migrate ..."
  fi

  # DIRECT_URL is the one migrations use, so it is the one that decides the
  # blast radius. Take the last inline assignment of it.
  direct_value="$(grep -oE "(^|[[:space:]])DIRECT_URL=['\"]?[^'\"[:space:]]+" <<<"$scan" | tail -1 | sed -E "s/.*DIRECT_URL=['\"]?//")"
  # Strip scheme and credentials, keep host[:port].
  direct_host="$(sed -E 's#^[a-zA-Z+]+://##; s#^[^@/]*@##; s#[/?].*$##' <<<"$direct_value")"

  case "$direct_host" in
    localhost|localhost:*|127.0.0.1|127.0.0.1:*|\[::1\]|\[::1\]:*)
      : # local scratch — this is what the workflow expects
      ;;
    *)
      # Not local. Allowed only as a deliberate, typed-out act.
      if ! grep -qE '(^|[[:space:]])EZYPRINT_ALLOW_REMOTE_MIGRATE=1' <<<"$scan"; then
        deny "Blocked: 'prisma migrate' resolves DIRECT_URL to a NON-LOCAL host.

  DIRECT_URL host: ${direct_host:-<could not parse — that alone is reason to stop>}

Migrations run against DIRECT_URL, so this would alter that database. If it is a Neon dev branch or you are deploying on purpose, say so explicitly by prefixing:

  EZYPRINT_ALLOW_REMOTE_MIGRATE=1 DATABASE_URL='...' DIRECT_URL='...' npx prisma migrate deploy

Before you do: 'prisma migrate status' with the same two variables is read-only and prints the datasource it resolved. Read that line first."
      fi
      ;;
  esac
fi

# ── Raw SQL ──────────────────────────────────────────────────────────────────

if grep -qiE '\b(DROP|TRUNCATE)[[:space:]]+(TABLE|DATABASE|SCHEMA)\b' <<<"$scan"; then
  deny "Blocked: DROP/TRUNCATE of a table, schema or database. If this is intentional cleanup, run it yourself after confirming which database you are connected to."
fi

# `deleteMany()` / `deleteMany({})` — no filter means every row.
if grep -qE 'deleteMany\([[:space:]]*(\{[[:space:]]*\})?[[:space:]]*\)' <<<"$scan"; then
  deny "Blocked: an unfiltered deleteMany() removes every row in the table. Add a where clause, or run it yourself if you mean it."
fi

exit 0
