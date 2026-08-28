-- ─────────────────────────────────────────────────────────────
-- Give a Student Pass purchase the row it never had.
--
-- One new enum, one new table, three indexes. Nothing existing is read,
-- altered or dropped — no column is added to `users`, no data is rewritten —
-- so a currently deployed server, which does not know the table exists, is
-- unaffected by it.
--
-- WHY
--
-- A print order cannot be paid for twice, and it is worth being precise about
-- what stops it. Two things do: the compare-and-swap on
-- `orders.paymentAttemptedAt`, which lets exactly one concurrent request reach
-- the gateway, and the unique index on `orders.razorpayOrderId`, which stops a
-- second gateway order being attached to it. Both live on a row.
--
-- A Student Pass purchase had no row, so it had neither. The only guard was
-- "is a pass currently active" — which is false for every first purchase and
-- for every renewal after expiry, i.e. exactly when two concurrent checkouts
-- are possible. Both passed it, both minted a real Razorpay order, and a
-- student who dismissed the first sheet and paid the second was charged twice
-- the moment the first UPI collect was approved. Nothing recorded the first
-- payment afterwards: `users.studentPassPaymentId` holds one id and had just
-- been overwritten, and `auditCapturedPayments` skips pass payments precisely
-- because there was no row to check them against.
--
-- A previous attempt at this put a TTL-bounded claim on `users`. That closed
-- the concurrent case and left the sequential one — a lapsed claim, a second
-- order — and it made the guarantee depend on a timer rather than on the
-- database. This replaces it. That migration was never committed or applied
-- anywhere, so it is superseded rather than reverted.
--
-- WHAT THE PARTIAL INDEX BUYS
--
-- `student_pass_purchases_one_open_per_user` is the whole mechanism. Two
-- concurrent inserts cannot both create an OPEN purchase for one student:
-- Postgres refuses the second in the index itself, so the guarantee does not
-- depend on the application remembering to check, on a claim not having lapsed,
-- or on two requests not arriving in the same millisecond.
--
-- Partial rather than a plain UNIQUE on (userId, status): a student may
-- legitimately accumulate any number of *resolved* purchases over the years,
-- and only the open one has to be singular. Same shape, and same reasoning, as
-- `reactivation_requests_one_pending_per_shop`.
--
-- WHY ROWS ARE KEPT RATHER THAN DELETED
--
-- An abandoned checkout keeps its row. A Razorpay order outlives our idea of
-- it — a UPI collect can be approved long after the sheet was dismissed — and
-- when that capture arrives it has to find the purchase it belongs to. Deleting
-- the row would recreate the original defect in a new place: money with nothing
-- to attach it to.
--
-- NULL SEMANTICS
--
-- `razorpayOrderId` is null only between claiming the open slot and the gateway
-- answering. It is UNIQUE, and Postgres permits many NULLs in a unique index,
-- so in-flight rows do not contend. `razorpayPaymentId` is null until capture,
-- for the same reason and with the same treatment.
--
-- NO BACKFILL, deliberately
--
-- The table starts empty. Passes already sold have no purchase row and will
-- never gain one — inventing rows for them would mean inventing a
-- `razorpayOrderId` and an `expiresAt` that nothing recorded, which is
-- manufacturing evidence rather than migrating it. The practical consequence is
-- that `auditCapturedPayments` would read a historical pass payment as an
-- orphan, so it judges only payments captured after this table existed; see the
-- `createdAt` floor in `auditCapturedPayments`.
-- ─────────────────────────────────────────────────────────────

CREATE TYPE "StudentPassPurchaseStatus" AS ENUM ('OPEN', 'PAID', 'ABANDONED', 'REFUSED');

CREATE TABLE "student_pass_purchases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "StudentPassPurchaseStatus" NOT NULL DEFAULT 'OPEN',
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "amountPaise" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "appliedFrom" TIMESTAMP(3),
    "refusedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_pass_purchases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "student_pass_purchases_razorpayOrderId_key"
  ON "student_pass_purchases" ("razorpayOrderId");

CREATE UNIQUE INDEX "student_pass_purchases_razorpayPaymentId_key"
  ON "student_pass_purchases" ("razorpayPaymentId");

CREATE INDEX "student_pass_purchases_userId_status_idx"
  ON "student_pass_purchases" ("userId", "status");

CREATE INDEX "student_pass_purchases_status_expiresAt_idx"
  ON "student_pass_purchases" ("status", "expiresAt");

ALTER TABLE "student_pass_purchases"
  ADD CONSTRAINT "student_pass_purchases_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The mechanism. Everything above is bookkeeping; this is what makes a second
-- open checkout impossible rather than merely unlikely.
CREATE UNIQUE INDEX "student_pass_purchases_one_open_per_user"
  ON "student_pass_purchases" ("userId")
  WHERE "status" = 'OPEN';
