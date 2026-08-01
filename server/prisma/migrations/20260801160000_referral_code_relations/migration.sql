-- ─────────────────────────────────────────────────────────────
-- Make referral codes say who issued them and who used them
--
-- `createdBy` and `usedBy` held user IDs with no foreign key, so the columns
-- could not be joined and nothing ever read them back. The record of which
-- admin authorised which stranger to register as a shop owner existed in the
-- database and was unreachable from the application.
--
-- Both sides are ON DELETE SET NULL rather than CASCADE. These rows are the
-- only account of how a shop owner got in; deleting the admin or the owner
-- should cost the name attached to the record, not the record.
--
-- That makes `usedBy` unsafe as the single-use guard — nulling it on account
-- deletion would make a spent code redeemable again, and deletable by an admin.
-- `usedAt` takes over that role below; it is written in the same statement as
-- `usedBy` and is never nulled.
-- ─────────────────────────────────────────────────────────────

-- 1. Guarantee every spent code has a `usedAt` before it becomes the guard.
--    Both redemption paths already write the two together, so this only covers
--    rows predating that.
UPDATE "referral_codes"
SET "usedAt" = "createdAt"
WHERE "usedBy" IS NOT NULL AND "usedAt" IS NULL;

-- 2. An admin may already have been deleted, and a NOT NULL column cannot hold
--    the resulting orphan.
ALTER TABLE "referral_codes" ALTER COLUMN "createdBy" DROP NOT NULL;

-- 3. Clear references to users that no longer exist. Adding the constraints
--    below would fail against them, and on production data that is a deploy
--    that stops halfway.
UPDATE "referral_codes"
SET "createdBy" = NULL
WHERE "createdBy" IS NOT NULL
  AND "createdBy" NOT IN (SELECT "id" FROM "users");

UPDATE "referral_codes"
SET "usedBy" = NULL
WHERE "usedBy" IS NOT NULL
  AND "usedBy" NOT IN (SELECT "id" FROM "users");

-- 4. The relations.
ALTER TABLE "referral_codes"
  ADD CONSTRAINT "referral_codes_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "referral_codes"
  ADD CONSTRAINT "referral_codes_usedBy_fkey"
  FOREIGN KEY ("usedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. Drives the sweep for codes that expired without ever being redeemed.
CREATE INDEX "referral_codes_usedAt_expiresAt_idx" ON "referral_codes"("usedAt", "expiresAt");
