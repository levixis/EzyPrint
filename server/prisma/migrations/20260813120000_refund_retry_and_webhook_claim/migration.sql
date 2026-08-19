-- ─────────────────────────────────────────────────────────────
-- Retryable refunds, and webhook deliveries that cannot double-process.
--
-- Three additive columns, all with defaults, all backfilled by the default on
-- existing rows. Nothing is dropped or rewritten, so this cannot affect an
-- order, a balance or an auth record.
-- ─────────────────────────────────────────────────────────────

-- 1. Per-attempt identity for refunds.
--
-- Every idempotency key derived from a RefundRequest — the Razorpay
-- X-Refund-Idempotency header and the shop's REFUND_DEDUCTION ledger eventId —
-- was keyed on the request id alone. A request row is reused across retries, so
-- a retry after REFUND_FAILED replayed the failed refund at the gateway and had
-- its ledger deduction deduped away. Counting attempts makes each try distinct.
--
-- `attempts` counts attempts the gateway has FAILED, so the live attempt is
-- `attempts + 1`. Zero is therefore correct for every row that has not failed —
-- including one currently in flight, whose refund was made under the attempt-1
-- key and must keep answering to it.
ALTER TABLE "refund_requests" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- Rows already sitting in REFUND_FAILED have exactly one abandoned attempt.
--
-- Without this their next retry would compute attempt 1 and collide on both
-- keys: Razorpay would return the dead refund rather than making a new one, and
-- `createLedgerEntry` would dedupe the shop's deduction against the entry whose
-- reversal has already credited them back. Clearing the refund id is the other
-- half — `settleClaimedRefund` reads a stored id as "already in flight" and
-- skips the gateway call entirely.
UPDATE "refund_requests"
   SET "attempts" = 1,
       "razorpayRefundId" = NULL
 WHERE "status" = 'REFUND_FAILED';

-- 2. Webhook delivery claim + attempt counter.
ALTER TABLE "webhook_events" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "webhook_events" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- The reconciliation sweep selects unprocessed events by (processed, attempts).
CREATE INDEX "webhook_events_processed_attempts_idx" ON "webhook_events"("processed", "attempts");

-- 3. Job leases, replacing the scheduler's session-level advisory locks.
--
-- `pg_try_advisory_lock` / `pg_advisory_unlock` are session-scoped, and at
-- runtime the app connects through Neon's PgBouncer pooler where a session is
-- not pinned across statements. The unlock could therefore run on a different
-- backend than the lock, quietly fail, and leave the job locked forever — after
-- which every run read that as "another instance has it" and skipped, silently
-- stopping settlement, reconciliation, the payment audit and file retention.
--
-- A lease expires on its own, so a crashed process cannot block a job
-- permanently, and it holds no connection while the job runs.
ALTER TABLE "job_heartbeats" ADD COLUMN "lockedUntil" TIMESTAMP(3);
ALTER TABLE "job_heartbeats" ADD COLUMN "lockedBy" TEXT;

-- 4. Normalise the one refundStatus value that was written in capitals.
--
-- The column holds 'processed' and 'pending' in lowercase and held 'FAILED' in
-- caps, so every reader had to special-case the spelling of a single state.
-- The server and both dashboards now write and read 'failed'; this brings the
-- rows already stored into line with them.
UPDATE "orders" SET "refundStatus" = 'failed' WHERE "refundStatus" = 'FAILED';
