-- ─────────────────────────────────────────────────────────────
-- Repair shops created at one paise a page.
--
-- REVIEW THIS BEFORE DEPLOYING — it changes live shop pricing.
--
-- The email/password signup path created shops with `bwPerPage = 1` and
-- `colorPerPage = 3`. Those are rupee figures that survived the migration to
-- paise, so every shop registered that way charges 1% of its intended rate: a
-- page meant to cost ₹1.00 costs ₹0.01, and the shop's ORDER_EARNING credit is
-- a hundredth of what it should be. The code defect is fixed — both signup
-- paths now defer to the schema defaults — but that only stops new shops being
-- created broken. Existing rows keep charging a paise a page until this runs.
--
-- Scoped to the exact signature of the bug: BOTH columns still at 1 and 3
-- together. A shop that has set its own pricing since has moved off those
-- values and is not touched. Nobody prices a black-and-white page at one paise
-- and a colour page at three deliberately, and the pair occurring together is
-- what makes this unambiguous rather than a guess.
--
-- Restores the schema defaults (₹1.00 and ₹3.00 per page), which is what these
-- shops would have been created with had the path been correct.
--
-- If any shop genuinely intends to print at these rates, delete this file
-- before deploying — the code fix stands on its own without it.
UPDATE "shops"
   SET "bwPerPage" = 100,
       "colorPerPage" = 300
 WHERE "bwPerPage" = 1
   AND "colorPerPage" = 3;
