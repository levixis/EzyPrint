-- ─────────────────────────────────────────────────────────────
-- Observability: what broke, what the watchdog did, and whether
-- the background jobs are running at all.
--
-- Three tables, no changes to anything that exists. Nothing here is on a
-- request path — every write is best-effort and swallowed by its caller — so
-- this migration cannot affect orders, money or auth even if the tables end up
-- empty.
--
-- All three are swept on a retention window rather than growing forever;
-- system_events is aggregated by fingerprint so volume lands in a counter
-- instead of in rows.
-- ─────────────────────────────────────────────────────────────

-- 1. Distinct failures, one row per fingerprint.
CREATE TYPE "SystemEventSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

CREATE TABLE "system_events" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" "SystemEventSeverity" NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "lastAlertedAt" TIMESTAMP(3),

    CONSTRAINT "system_events_pkey" PRIMARY KEY ("id")
);

-- The upsert in observability.service keys on this; without the unique index
-- concurrent reports of the same defect would each insert their own row.
CREATE UNIQUE INDEX "system_events_fingerprint_key" ON "system_events"("fingerprint");
CREATE INDEX "system_events_resolvedAt_lastSeenAt_idx" ON "system_events"("resolvedAt", "lastSeenAt");
CREATE INDEX "system_events_severity_lastSeenAt_idx" ON "system_events"("severity", "lastSeenAt");

-- 2. Last completed run of each background job.
--    Keyed on the job name, so the scheduler upserts without needing to know
--    whether the row exists — which matters on a fresh database and on a host
--    that restarts constantly.
CREATE TABLE "job_heartbeats" (
    "name" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastDurationMs" INTEGER,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_heartbeats_pkey" PRIMARY KEY ("name")
);

-- 3. Append-only audit of every automatic action taken.
CREATE TYPE "RemediationOutcome" AS ENUM ('SKIPPED', 'SUCCEEDED', 'FAILED', 'BLOCKED');

CREATE TABLE "remediation_log" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "outcome" "RemediationOutcome" NOT NULL,
    "detail" JSONB,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "remediation_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "remediation_log_action_createdAt_idx" ON "remediation_log"("action", "createdAt");
CREATE INDEX "remediation_log_createdAt_idx" ON "remediation_log"("createdAt");
