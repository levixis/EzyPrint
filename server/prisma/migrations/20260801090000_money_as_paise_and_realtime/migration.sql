-- ─────────────────────────────────────────────────────────────
-- Money becomes integer paise
--
-- Every monetary column was DOUBLE PRECISION. Binary floating point cannot
-- represent ₹0.10 exactly, so repeated ledger arithmetic accumulates drift that
-- never reconciles against Razorpay to the paisa. Paise is also the unit
-- Razorpay's API already speaks, so the conversion at the boundary disappears.
--
-- USING ROUND(col * 100) converts the existing rupee values in place. Without
-- the USING clause Postgres would truncate ₹12.50 to 12 instead of 1250.
-- ─────────────────────────────────────────────────────────────

-- shops
ALTER TABLE "shops"
  ALTER COLUMN "bwPerPage"      TYPE INTEGER USING ROUND("bwPerPage" * 100),
  ALTER COLUMN "bwPerPage"      SET DEFAULT 100,
  ALTER COLUMN "colorPerPage"   TYPE INTEGER USING ROUND("colorPerPage" * 100),
  ALTER COLUMN "colorPerPage"   SET DEFAULT 300,
  ALTER COLUMN "pendingBalance" TYPE INTEGER USING ROUND("pendingBalance" * 100),
  ALTER COLUMN "pendingBalance" SET DEFAULT 0,
  ALTER COLUMN "ledgerBalance"  TYPE INTEGER USING ROUND("ledgerBalance" * 100),
  ALTER COLUMN "ledgerBalance"  SET DEFAULT 0,
  ALTER COLUMN "debtAmount"     TYPE INTEGER USING ROUND("debtAmount" * 100),
  ALTER COLUMN "debtAmount"     SET DEFAULT 0;

-- orders
ALTER TABLE "orders"
  ALTER COLUMN "pageCost"     TYPE INTEGER USING ROUND("pageCost" * 100),
  ALTER COLUMN "pageCost"     SET DEFAULT 0,
  ALTER COLUMN "baseFee"      TYPE INTEGER USING ROUND("baseFee" * 100),
  ALTER COLUMN "baseFee"      SET DEFAULT 0,
  ALTER COLUMN "totalPrice"   TYPE INTEGER USING ROUND("totalPrice" * 100),
  ALTER COLUMN "totalPrice"   SET DEFAULT 0,
  ALTER COLUMN "refundAmount" TYPE INTEGER USING ROUND("refundAmount" * 100);

-- payouts
ALTER TABLE "payouts"
  ALTER COLUMN "amount" TYPE INTEGER USING ROUND("amount" * 100);

-- ledger_entries
ALTER TABLE "ledger_entries"
  ALTER COLUMN "amount" TYPE INTEGER USING ROUND("amount" * 100);

-- shop_aggregates
ALTER TABLE "shop_aggregates"
  ALTER COLUMN "totalRevenue"   TYPE INTEGER USING ROUND("totalRevenue" * 100),
  ALTER COLUMN "totalRevenue"   SET DEFAULT 0,
  ALTER COLUMN "totalBaseFees"  TYPE INTEGER USING ROUND("totalBaseFees" * 100),
  ALTER COLUMN "totalBaseFees"  SET DEFAULT 0,
  ALTER COLUMN "totalPaidOut"   TYPE INTEGER USING ROUND("totalPaidOut" * 100),
  ALTER COLUMN "totalPaidOut"   SET DEFAULT 0,
  ALTER COLUMN "pendingPayouts" TYPE INTEGER USING ROUND("pendingPayouts" * 100),
  ALTER COLUMN "pendingPayouts" SET DEFAULT 0;

-- refund_requests
ALTER TABLE "refund_requests"
  ALTER COLUMN "refundAmount" TYPE INTEGER USING ROUND("refundAmount" * 100);

-- earnings_reports
ALTER TABLE "earnings_reports"
  ALTER COLUMN "totalRevenue"   TYPE INTEGER USING ROUND("totalRevenue" * 100),
  ALTER COLUMN "totalRevenue"   SET DEFAULT 0,
  ALTER COLUMN "totalBaseFees"  TYPE INTEGER USING ROUND("totalBaseFees" * 100),
  ALTER COLUMN "totalBaseFees"  SET DEFAULT 0,
  ALTER COLUMN "totalPageCosts" TYPE INTEGER USING ROUND("totalPageCosts" * 100),
  ALTER COLUMN "totalPageCosts" SET DEFAULT 0;

-- ─────────────────────────────────────────────────────────────
-- Payout in-transit state
--
-- Approval means the transfer was initiated, not that the bank credited it.
-- Collapsing the two is what makes a shop owner think money went missing.
-- ─────────────────────────────────────────────────────────────
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';

-- ─────────────────────────────────────────────────────────────
-- Settlement promise, stamped at credit time
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "ledger_entries" ADD COLUMN "availableAt" TIMESTAMP(3);

CREATE INDEX "ledger_entries_status_availableAt_idx"
  ON "ledger_entries"("status", "availableAt");

-- ─────────────────────────────────────────────────────────────
-- One Razorpay order per EzyPrint order, enforced by the database
--
-- Previously a plain index. Two concurrent "Pay" taps could each create a real
-- Razorpay order, and the second write would overwrite the first — leaving a
-- captured payment whose webhook matched no row.
-- ─────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "orders_razorpayOrderId_idx";

CREATE UNIQUE INDEX "orders_razorpayOrderId_key"
  ON "orders"("razorpayOrderId");

CREATE INDEX "orders_status_paymentAttemptedAt_idx"
  ON "orders"("status", "paymentAttemptedAt");

-- ─────────────────────────────────────────────────────────────
-- Real-time outbox
-- ─────────────────────────────────────────────────────────────
CREATE TABLE "realtime_outbox" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "seq" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realtime_outbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "realtime_outbox_publishedAt_createdAt_idx"
  ON "realtime_outbox"("publishedAt", "createdAt");
