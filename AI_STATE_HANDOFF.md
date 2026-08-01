# AI STATE HANDOFF
> **STATUS**: Green | **LAST UPDATE**: 2026-08-01 | **TESTS**: 91/91 | **TSC**: 0 errors (server + web) | **BUILD**: passing

## 1. METADATA & TECH STACK
* **Project**: EzyPrint — campus print-order marketplace (students → shops)
* **Stack**: React 19 + Vite 8 + TailwindCSS 3 | Express 5 + Prisma 6 + PostgreSQL 15 (Neon) | TypeScript
* **Real-time**: Pusher (private per-shop channels, transactional outbox)
* **Deploy target**: Railway (API) + Neon (DB) + Cloudflare R2 (files) + Vercel (web)
* **Git Branch**: `migrate/new-backend`

## 2. THE BIG ONE — shops are now actually paid

The migrated backend **never credited shops**. No code path anywhere created an
`ORDER_EARNING` ledger entry, and `ledgerBalance` / `debtAmount` were returned to
the frontend but never written. That logic lived only in the legacy Firebase
`functions/` and was never ported, so every shop balance was structurally ₹0 and
every payout request failed the ledger's own insufficient-balance check.

The earnings model is now implemented server-side, with money visible at four
stages rather than appearing only when it lands:

```
in progress  →  clearing  →  available  →  paid out
(paid, not      (earned,      (with-        (sent to
 yet made)       settling)     drawable)     bank)
```

* `server/src/services/settlement.service.ts` — credits on order `COMPLETED`,
  stamps `availableAt` at write time so the dashboard can promise an exact
  release time, and sweeps matured earnings into `available`.
* `server/src/services/ledger.service.ts` — balance movement across the two
  stored buckets plus debt. Credits pay down debt first; debits drain their own
  bucket, spill to the other, then accrue debt rather than going negative.
* `server/src/services/scheduler.service.ts` — runs the settlement sweep, the
  Razorpay reconciliation (which previously had **no caller at all**), and the
  outbox dispatcher. Each holds a Postgres advisory lock, so extra replicas are
  safe.

## 3. MONEY IS INTEGER PAISE

All 19 monetary columns moved from `DOUBLE PRECISION` to `INTEGER` paise, with a
data migration that multiplies existing values by 100. Razorpay already speaks
paise, so the conversion at that boundary disappeared.

* Server: `server/src/services/pricing.service.ts` is the price authority.
* Web: `utils/money.ts` (`formatMoney`, `rupeesToPaise`, `paiseToRupees`).
  Rupees exist only in display strings and in fields a human types into.
* `utils/pricing.ts` mirrors the server rules for live estimates — **keep them
  in sync or the quote will not match the charge.**

## 4. REAL-TIME LEDGER (Pusher)

* Channel `private-shop-{shopId}`; auth at `POST /api/v1/realtime/auth`, behind
  the normal `authenticate` middleware. Only the shop's owner or an admin.
* Events are written to `realtime_outbox` **inside the same transaction** as the
  money movement, then published after commit. The dispatcher re-sends anything
  whose process died in between, so delivery is at-least-once.
* Envelopes carry `seq` (= `Shop.financialVersion`). The client drops anything
  already applied and refetches on a gap — Pusher guarantees neither ordering
  nor exactly-once.
* Client: `lib/realtime.ts`, `lib/useShopLedger.ts`. Uses a custom Pusher
  `authorizer` so channel auth goes through `lib/api.ts` and inherits the
  401 → refresh → retry logic.
* **Optimistic UI applies to order status only** (`optimisticOrderStatus` in
  `contexts/AppContext.tsx`). Balances are never optimistic and have no
  mutation path — money on screen is always server-confirmed.

## 5. SECURITY FIXES

* **Google OAuth accepted tokens minted for any Google app** — no `aud` check
  existed. Now verified against `GOOGLE_CLIENT_IDS` on both the id_token and
  access_token paths, plus `email_verified`.
* **Double-charge race** on payment creation — check-then-act around a live
  Razorpay call. Now an atomic claim before the call, plus a unique constraint
  on `orders.razorpayOrderId`.
* **Payout approval had no OTP** despite the UI collecting one (Zod stripped
  it). OTP is now enforced and scoped per record (`payout_<id>`,
  `refund_<id>`, `reactivation_<id>`), stored hashed, and consumed by a single
  atomic DELETE so it cannot be replayed concurrently.
* **Refresh token rotation** — a plain `update` let a stolen token and the real
  client both succeed. Now a compare-and-swap; losing the claim revokes all
  sessions.
* **Rate limiting was one global bucket** — no `trust proxy` behind Railway, so
  20 bad logins locked out everyone. Fixed, and auth limits now key on the
  target account.
* Constant-time HMAC compare, `RAZORPAY_WEBHOOK_SECRET` required in production,
  webhook insert made an upsert, order status transitions use CAS, shops with
  financial history can no longer be hard-deleted.

## 6. VERIFICATION

```bash
cd server && npm test          # 91/91
cd server && npx tsc --noEmit  # 0 errors
npx tsc --noEmit               # 0 errors (web)
npm run build                  # passes
```

Migrations were checked against the schema with
`prisma migrate diff --from-empty --to-schema-datamodel`: tables and unique
indexes match exactly, and zero `DOUBLE PRECISION` columns remain.

## 7. NEXT STEPS

1. [ ] **Set the new required env vars before deploying** — the server refuses
   to boot in production without them: `GOOGLE_CLIENT_IDS`,
   `RAZORPAY_WEBHOOK_SECRET`, `PUSHER_APP_ID`/`KEY`/`SECRET`, `DIRECT_URL`.
   Web needs `VITE_PUSHER_KEY` and `VITE_PUSHER_CLUSTER`. See
   `server/.env.example`.
2. [ ] Run `prisma migrate deploy` against a staging copy first — the paise
   migration rewrites every money column and is not reversible in place.
3. [ ] Admin UI for the new `IN_TRANSIT` payout step (`POST
   /payouts/:id/mark-paid` exists and `payoutApi.markPaid` is wired; the
   dashboard still needs a button).
4. [ ] Delete `.github/workflows/deploy.yml` and the legacy `functions/` +
   Firestore rules once the Railway/Vercel pipeline is live. The workflow's
   automatic trigger is removed but the file remains.
5. [ ] `server/.env.render` is a stale Render config pointing at a **non-pooled**
   Neon endpoint. Replace with Railway config; do not copy it as-is.
