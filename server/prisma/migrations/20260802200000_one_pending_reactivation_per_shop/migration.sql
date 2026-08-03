-- ─────────────────────────────────────────────────────────────
-- One pending reactivation request per shop
--
-- `POST /reactivation/submit` decided whether a request already existed by
-- reading first and creating second:
--
--     findFirst({ shopId, status: 'pending' })  →  create({ ... })
--
-- Nothing stood between those two statements. Two taps on "Request
-- Reactivation" — which is exactly what a locked-out owner does when the first
-- tap appears to do nothing — produce two pending rows. The admin then sees the
-- same request twice, approves one, and the second stays pending forever
-- against a shop that is already active again: an item in the queue that can
-- never be cleared correctly, because approving it re-approves something that
-- already happened.
--
-- The same shape as the double-charge race on payment creation, with money
-- swapped for an admin's attention.
--
-- A partial unique index is the fix rather than a plain @@unique on
-- (shopId, status): a shop may legitimately accumulate any number of *resolved*
-- requests over its life — archived, reinstated, archived again — and only the
-- pending one has to be singular. Postgres enforces this in the index itself,
-- so the guarantee does not depend on the application remembering to check.
--
-- Prisma's schema language cannot express a partial index, so it is declared
-- here and recorded in schema.prisma as a comment beside the model.
-- ─────────────────────────────────────────────────────────────

-- Safe to create directly: any pre-existing duplicates would abort this
-- statement rather than be silently dropped, which is the right failure — a
-- duplicate pending request is a decision for a human, not for a migration.
CREATE UNIQUE INDEX "reactivation_requests_one_pending_per_shop"
  ON "reactivation_requests" ("shopId")
  WHERE "status" = 'pending';
