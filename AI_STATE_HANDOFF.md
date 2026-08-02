# AI STATE HANDOFF
> **STATUS**: Green | **LAST UPDATE**: 2026-08-02 | **TESTS**: 234 server + 123 web | **TSC**: 0 errors (server + web) | **BUILD**: passing | **ANDROID**: compiles

## 1. METADATA & TECH STACK
* **Project**: EzyPrint — campus print-order marketplace (students → shops)
* **Stack**: React 19 + Vite 8 + TailwindCSS 3 | Express 5 + Prisma 6 + PostgreSQL 15 (Neon) | TypeScript
* **Real-time**: Pusher (private per-shop channels, transactional outbox)
* **Deploy target**: Render (API) + Neon (DB) + Cloudflare R2 (files) + Vercel (web)
  — see §5d. Comments in `server/src` still say "Railway"; that was the plan, not
  what shipped. What they describe holds on Render too, which also terminates at
  one edge proxy, so `TRUST_PROXY_HOPS=1` stays correct.
* **Git Branch**: `main`

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

## 5b. NOTIFICATIONS — they now exist at all

`createNotification` was defined and **never called from anywhere**. Nothing in
`server/src` wrote to the `notifications` table, so the bell was permanently
empty for every account; the only things users saw were session-local toasts
that vanished on refresh. Push was severed at both ends: the client posted its
FCM token to `/users/me/push-token`, which **did not exist** (the 404 was
swallowed), and there was no send path — no `firebase-admin`, nothing writing
`User.fcmTokens`.

* `server/src/services/notify.service.ts` — routing. Who hears about an event is
  a property of the event, not of the call site. The rule throughout is **never
  notify someone about their own action**; a shop that buzzes on its own button
  presses gets muted, which costs it the one notification that matters.
  * orders → student on shop-driven changes; shop on a new paid order and on a
    student cancellation.
  * tickets → all admins, plus the shop when the ticket is filed against it,
    plus the raiser on replies and resolution.
  * money → shop owner on earnings and payouts.
* `server/src/services/push.service.ts` — FCM transport only, no Firestore/Auth.
  Fails soft everywhere: a missing `FIREBASE_SERVICE_ACCOUNT` degrades to
  in-app-only rather than taking the server down. Prunes tokens FCM reports
  dead, and reclaims a token when a different account registers it, so handing
  a phone over does not keep delivering the previous owner's orders.
* Exactly-once on new-order announcements: three paths move an order to
  `PENDING_APPROVAL` (signature, webhook, reconciliation). Each now guards its
  write on the prior status and announces only if **its own** update applied.
* Android channels are created **only** in `MainActivity.java`, split into
  `ezyprint_orders` / `ezyprint_tickets` / `ezyprint_account`. Android ignores a
  channel create for an existing ID, which is why the JS-side settings in
  `utils/pushNotifications.ts` were silently discarded. The channel IDs are
  duplicated in `push.service.ts` and **must stay in sync** — a message naming a
  channel that does not exist is dropped silently on Android 8+.

## 5c. GESTURES

* `utils/backGesture.ts` — a dismiss stack for the Android back gesture. The
  handler in `App.tsx` could only change views, so swiping back with the
  notification panel open navigated underneath it. Overlays register a dismiss
  fn; back takes the top of the stack first and only then navigates. `goBack()`
  now returns a boolean so an empty history falls through to `minimizeApp()`
  instead of leaving the app looking frozen.
* `utils/useSwipeToDismiss.ts` — swipe-to-dismiss on notification rows, on
  Pointer Events with pointer capture. Axis-locked on the first 8px: **ties go
  to the scroller**, because stealing an ambiguous gesture from scrolling is
  much worse than missing an ambiguous swipe. `touch-action: pan-y` keeps
  vertical panning on the compositor.

## 5d. DEPLOYED — and what deploying changed

The migration branch is merged (`3da173a`); work is on `main`. The API runs on
**Render** (`https://ezyprint-backend.onrender.com`) rather than Railway — a temporary
choice, not a redesign. Web is on Vercel, DB on Neon, files on R2, as planned.

* **Render's free tier sleeps**, and a sleeping instance runs no scheduler — the
  settlement sweep, the Razorpay reconciliation and the outbox dispatcher all stop
  until the next request wakes it. See §7.
* A "CORS error" in the console was a **502**: the backend was down, and Render's own
  error page carries no `Access-Control-Allow-Origin`. Curl the endpoint before
  believing a CORS message.
* Google sign-in failed in Firefox with `Failed to open popup window`. The GSI script
  was loaded on click, so `requestAccessToken()` fired from a `load` event with no user
  gesture behind it. Fixed by preloading in `index.html`.

## 5e. THE WEBHOOK HAD NEVER PROCESSED A SINGLE EVENT

Every Razorpay delivery had been returning **400** since the day it was wired. The
handler read `event.id` from the body; Razorpay sends it in the **`X-Razorpay-Event-Id`
header**. So the idempotency key was always undefined, and nothing downstream of a
payment had ever run in production — not the ledger credit, not the status flip.

* `server/src/controllers/payment.controller.ts:93` reads the header;
  `server/src/services/payment.service.ts:403` prefers it and rejects a delivery with
  neither.
* `payment.captured` now **verifies the amount against the order total** before marking
  it paid. A webhook asserting "paid" is not evidence of *how much* was paid.
* `payment.service.ts:249` binds the order to its `razorpayOrderId`. That comparison is
  the anti-replay check — **do not remove it.**
* **Student Pass** was made purchasable (`createStudentPassOrder`,
  `verifyStudentPassPayment`, `activateStudentPass`), and then failed to activate after
  a real ₹49 capture. `{ not: paymentId }` compiles to SQL `<>`, and `NULL <> 'x'` is
  NULL rather than TRUE, so `updateMany` matched **zero rows for every first-time
  buyer** — the only people who can buy it. Now:

  ```ts
  OR: [{ studentPassPaymentId: null }, { studentPassPaymentId: { not: paymentId } }]
  ```

  Confirmed against the database (0 rows vs 1) before and after, not by reading.

## 5f. PRICE INTEGRITY — the server counts the pages

`pageCount` arrived from the client and was priced as given, so a student could name
their own number. A separate scenario let a student credit **another shop's** ledger.

* `server/src/services/pagecount.service.ts` — `countPages(buffer, mimeType)` returns
  `{ pages, counted }`. A corrupt file returns `counted: false`, **never 0** — zero
  pages would price as free.
* `order.service.ts:600 repriceFromVerifiedPages(orderId)` runs before
  `createPaymentOrder` charges, so the price comes from the bytes we hold. The quote the
  student sees and the amount they are charged derive from the same count.
* **Role-aware transitions** — `TRANSITIONS_BY_ROLE` / `canRoleTransition`
  (`order.service.ts:66`, `:87`). A student may cancel while `PENDING_APPROVAL`; once
  the shop is `PRINTING` the paper is already spent, and cancellation is not offered.
  The missing student-ownership check on transitions was added at the same time.
* **Auto-refund on cancellation** — `server/src/services/refund.service.ts`.
  `claimCancellationRefund` and `settleClaimedRefund` are shared by the admin resolve
  path and the automatic one **so the two cannot drift on who absorbs the gateway
  fee**. `shopShareOfRefund` in `ledger.service.ts` caps the clawback at what the shop
  was actually credited (`earn:{orderId}`), so a refund can never claw back money a
  shop never received.

## 5g. FILES ARE DELETED WHEN THE ORDER IS DONE

Nothing was ever deleted. Documents students uploaded — ID scans, assignments, medical
forms — accumulated in R2 forever. The rule is now Blinkit's: **no retention window.**
The file exists to be printed; once it is printed it is a liability. Ordering the same
document again means uploading it again.

`server/src/services/cleanup.service.ts` — `isTerminalForFiles`, `purgeOrderFiles`,
`purgeTicketAttachments`, `sweepUndeletedFiles`, plus `hasOpenDispute`.

* `PAYMENT_FAILED` is deliberately **not** terminal — the student is about to retry
  with the same file.
* An open dispute or an unsettled refund (`UNSETTLED_REFUND_STATUSES`, which includes
  `REFUND_FAILED`) **holds the files**: the evidence has to outlive the order it is
  evidence about.
* Ticket attachments are purged on resolution.
* `sweepUndeletedFiles` catches whatever an inline delete missed, on
  `FILE_RETENTION_SWEEP_INTERVAL_MS` (hourly). Deletion is best-effort inline and
  guaranteed by the sweep.

## 5h. TYPES ARE NOW VALIDATED, NOT ASSERTED

The through-line of this whole session: the frontend **asserted** the server's response
shape with `as` instead of checking it. Any collection the endpoint didn't send became
a crash at `.length`, and the crash took the whole page with it — a blank screen, twice.

* `lib/schemas.ts` — `parseResponse` **never throws**; `list = (item) =>
  z.array(item).catch([])` degrades a malformed collection to empty rather than blanking
  the page; every object is `.loose()`, so a field the server adds later is not a
  breaking change.
* `utils/datetime.ts` — `toDate` / `formatDateTime` / `formatDate`. Cannot produce
  "Invalid Date".
* The frontend had **zero** tests against 134 on the server. The suite added
  (`components/tickets/*.test.tsx`, `lib/schemas.test.ts`, `utils/*.test.ts`) is aimed
  at the bugs that actually shipped, not at a coverage number.
* **Guarding one collection only moves the crash.** `TicketList` was fixed and tested
  for `messages`; opening a ticket then blanked the page on `statusHistory`. Every
  `.length` and `.map` in the component was audited the second time. Test the pattern,
  not the file that happened to crash.

## 5i. TICKETS

Support was the least-exercised surface in the app and had four independent breaks.

* A **shop owner could not see tickets filed against their own shop**.
  `shopIdForOwner()` and `canAccessTicket()` in `ticket.service.ts` now resolve all
  three parties (raiser, shop, admin).
* `listTickets` returned only `_count`, while the UI read `messages.length` → blank
  page. It now includes `messages`, `attachments` and `statusHistory`, and flattens
  `_count` → `messageCount`.
* Attachments can be sent **with a reply**, not only at ticket creation — the composer
  was text-only, so a student mid-conversation could not send the screenshot the
  conversation was about. 5MB cap with a stated reason; the upload id is minted at pick
  time so a retry dedupes server-side rather than storing the file twice.
* Migration `20260801140000_attachment_message_link` links an attachment to the message
  it was sent with, so files render **in the bubble** instead of a detached side list.
* Previewing opens **over** the conversation. Escape is captured before the ticket modal
  sees it — otherwise dismissing a screenshot closes the whole thread.
* **Known limitation**: PDFs preview through an `<iframe>` on the presigned R2 URL.
  Chrome, Firefox and desktop Safari render it; **iOS Safari often shows a blank
  frame**. "Open original" is the fallback. The fix, if it bites, is routing PDFs
  straight to a new tab on iOS rather than embedding.

## 5j. A FORGOTTEN PASSWORD WAS A LOST ACCOUNT

There was no reset anywhere — no endpoint, no link on the login screen, no
`changePassword`. The only way back in was accidental: `loginWithGoogle` matches
an existing account by **verified email** as well as `googleId`
(`auth.service.ts:375`), so a Google user signs in past their own forgotten
password. That covers people on a Google address and nobody else. In production
every student and the admin were Google; the **one account with a password was
the shop owner**, which is the account that holds money and requests payouts.

`server/src/services/passwordReset.service.ts`, `POST /auth/forgot-password` and
`POST /auth/reset-password`.

* **A 6-digit code, not a reset link.** The app ships as a Capacitor Android
  build as well as web, and a link in an email opens the phone's browser, not
  the app — a link needs deep-link plumbing plus a hosted landing page to serve
  one flow. A typed code works identically everywhere, and reuses `otp.service`,
  which is already hardened: hashed at rest, single-use via one atomic
  conditional DELETE, 3 wrong guesses then a 15-minute lockout.
* **Both endpoints are enumeration-safe.** `forgot-password` answers 200 for an
  address with no account, and swallows mail-delivery failures, because "we
  could not send to that address" is the same disclosure by another route. An
  unknown address given to `reset-password` throws the *exact* message
  `consumeOtp` gives for an account that never requested one. Otherwise the
  login screen becomes a way to test which of 30,000 campus addresses are
  registered.
* **A reset revokes every refresh token, in the same transaction as the password
  write.** People reset precisely because they think someone else has their
  password; that someone is signed in holding a refresh token which keeps
  working forever regardless. Split across two round trips, a crash between them
  leaves the password changed and the intruder's session alive.
* **No tokens are returned** — a successful reset does not sign you in. Reaching
  the inbox proves the account is yours, not that the device should be trusted.
* `passwordResetLimiter` — **3/hour keyed on the target address**, much tighter
  than `authLimiter`'s 20/15min and for a different threat: this endpoint makes
  us send mail to an address an anonymous caller names, so the abuse is inbox
  flooding and burning the provider's reputation, not credential guessing.
  `reset-password` is deliberately *not* behind it, since submitting a code
  sends no mail and the OTP lockout already bounds guessing.
* Google-only accounts are allowed through, which sets a password where there
  was none. That grants nothing: the code goes to the inbox, and whoever holds
  the inbox already controls the Google account. Refusing them would mean
  answering differently depending on how an account authenticates.
* **Blocked on the domain.** `onboarding@resend.dev` only delivers to the Resend
  account owner, so until a domain is verified this flow works for exactly one
  mailbox. Same blocker as the payout/deletion OTPs.

## 6. VERIFICATION

```bash
cd server && npm test          # 234/234
cd server && npx tsc --noEmit  # 0 errors
npm test                       # 123/123 (web, vitest)
npx tsc --noEmit               # 0 errors (web)
npm run build                  # passes
cd android && ./gradlew compileDebugJavaWithJavac   # compiles
```

Migrations were checked against the schema with
`prisma migrate diff --from-empty --to-schema-datamodel`: tables and unique
indexes match exactly, and zero `DOUBLE PRECISION` columns remain.

## 7. NEXT STEPS

1. [ ] **The `refund.*` Razorpay webhooks may never have been selected.**
   `payment.authorized`, `payment.captured` and `payment.failed` are confirmed
   arriving and processing (11 rows in `webhook_events`, all `processed`), but
   `refund.processed` and `refund.failed` have **zero rows** despite three
   `RESOLVED_REFUNDED` refund requests. Either they are not ticked in the
   dashboard or those refunds never reached the gateway. Check both.
2. [ ] **Buy and verify a domain with Resend (~₹800/yr).** `onboarding@resend.dev`
   delivers *only* to the Resend account owner, so every emailed code reaches one
   mailbox and nobody else: password resets (§5j), payout OTPs, account-deletion
   OTPs. Three shipped features are inert until this is done — this is the
   cheapest unblock on the list.
3. [ ] Razorpay is still on `rzp_test_` keys.
4. [ ] **Render's free tier sleeps, and a sleeping instance runs no scheduler** —
   settlement, reconciliation and the outbox dispatcher silently stop. It also
   blocks outbound SMTP on ports 25/465/587 — which is why OTP mail goes over
   Resend's HTTP API (`email.service.ts`) rather than Gmail SMTP — and drops the
   first request after idle. The $7 Starter plan is the fix for all three.
5. [x] ~~Delete `.github/workflows/deploy.yml` and the legacy `functions/` +
   `firestore.rules` / `storage.rules`.~~ **Done — repo side only.** Removed:
   `functions/`, `firestore.rules`, `firestore.indexes.json`, `storage.rules`,
   `database.rules.json`, `firebase.json`, `.firebaserc`, `.firebase/`,
   `cors.json`, `firebase.ts.bak`, the workflow, and the unread `VITE_FIREBASE_*`
   block in `.env.local`. **`firebase-admin` on the server is untouched** — it is
   the FCM transport; removing it disables push.

   **Still open, and it is the part that matters:** the legacy functions may
   still be *deployed*. Deleting the source does not undeploy them. They hold a
   divergent copy of the ledger/settlement logic and `functions/.env` shows they
   ran against the **live** Razorpay key (`rzp_live_…`) while `server/.env` here
   uses a test key. Schedulers keep firing on their own: `settleShopEarnings`,
   `cleanupAbandonedOrders`, `autoEscalateRefundRequests` (12h),
   `autoCloseResolvedTickets` (24h), `cleanupOldNotifications`, `cleanupOldTickets`,
   `scheduledFirestoreExport`. The `onCall` refund entry points remain reachable
   by any old APK still installed. Verify with
   `firebase functions:list --project ezyyprint` and delete before disabling
   Firestore — a function that loses its database mid-write is worse than one
   that is gone.

   `functions/.env` was **kept on disk** (gitignored, now the directory's only
   file): it is the only local copy of the live Razorpay secret. Move it to a
   password manager, then delete the directory.

   Firebase products safe to disable once the functions are gone: Firestore,
   Auth, Storage, Hosting. **Do not delete the Google Cloud project** — it holds
   the FCM registration and the Google Sign-In OAuth client IDs
   (`283831997162-…`) that `GOOGLE_CLIENT_IDS` and `capacitor.config.ts` depend on.
6. [ ] Delete `server/.env.render` — a stale config pointing at a **non-pooled**
   Neon endpoint. It is not what the live service uses; do not copy it as-is.
7. [ ] No CI runs either test suite. Both pass locally and nothing enforces that.
8. [ ] `contexts/AppContext.tsx` (~1700 lines) has no tests — and it is where the
   blank-page bugs in §5h originated.
9. [ ] Rotate the Neon password on the `pre-paise-backup` branch; it still holds
   the pre-rotation credential.
10. [ ] Verify PDF preview on iOS Safari (§5i) before telling students it works
    there.
11. [ ] **`server/ezyyprint-firebase-adminsdk-fcm.json` is the only copy** of the
    FCM service-account key (gitignored by `*-firebase-adminsdk-*.json`). A
    service account private key cannot be re-downloaded, only re-minted. Back it
    up somewhere that is not this laptop.
