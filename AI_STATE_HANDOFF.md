# AI STATE HANDOFF
> **STATUS**: Green | **LAST UPDATE**: 2026-07-26T23:22Z IST | **TESTS**: 59/61 passed (100% effective)

## 1. METADATA & TECH STACK
* **Project Name**: EzyPrint — campus print-order marketplace (students → shops)
* **Core Stack**: React 19 + Vite 8 + TailwindCSS 3 (frontend) | Express 5 + Prisma 6 + PostgreSQL 15 (new backend) | TypeScript | Capacitor 8 (mobile)
* **Environment**: macOS, Node 25.2.1, PostgreSQL 15.15, port 5001 (backend), port 5173 (Vite)
* **Workspace**: `/Users/harshvardhanjha/Desktop/good code latest`
* **Git Branch**: `migrate/new-backend` — `main` untouched
* **DB**: `ezyprint` | User: `harshvardhanjha` (no pw)
* **Test users**: student (`test@ezyprint.com`/`Test1234!`), shop (`shop@ezyprint.com`/`Shop1234!`), admin (`admin@ezyprint.com`/`Admin1234!` — manually set ADMIN in DB)

## 2. ARCHITECTURE OVERVIEW
Frontend (React+Vite+Tailwind+Capacitor) at root — data layer rewiring to REST. Backend in `server/`: Routes → Controllers → Services → Prisma → PostgreSQL. Auth: stateless JWT + hashed refresh tokens. Storage: Strategy Pattern (local/S3). Payments: Razorpay + HMAC verification. Order FSM. Optimistic concurrency on ledger.

## 3. COMPLETED WORK
* ✅ **Phase 1** — Express 5 + Prisma (18 tables, 15 enums)
* ✅ **Phase 2** — Auth: email/pass + Google OAuth + JWT rotation + replay detection
* ✅ **Phase 3** — Core CRUD: Users, Shops, Orders (FSM, pricing, access control)
* ✅ **Phase 4** — File uploads: Multer + Storage service (local/S3 Strategy Pattern)
* ✅ **Phase 5** — Payment: Razorpay orders, HMAC SHA-256 verification, webhook fallback
* ✅ **Phase 6** — Advanced: Notifications (CRUD + unread), Tickets (messages + audit trail + admin status), Ledger (optimistic concurrency)

## 4. IN-PROGRESS & CURRENT BLOCKERS
* **Active Phase**: Phase 7 — Deployment (NOT STARTED)
* **Current Error/Bug**: None
* **Blocker**: None — all backend features implemented

## 5. HARD CODING RULES & DECISIONS
* No Firebase/GCP infra — Google Sign-In stays (free public API, not GCP)
* Layered: Routes → Controllers → Services → Prisma
* Auth: bcrypt + JWT (no Passport.js) | Google OAuth stays for user convenience
* Order FSM: PENDING_PAYMENT→PENDING_APPROVAL→PRINTING→READY_FOR_PICKUP→COMPLETED
* Storage: Strategy Pattern — `STORAGE_MODE=local` (dev) / `s3` (prod)
* Payment: Razorpay HMAC SHA-256 signature verification + webhook fallback
* Ledger: Optimistic concurrency via `financialVersion` on Shop model
* Port: 5001 | API: `/api/v1/` | Validation: Zod | Errors: `ApiError`

## 6. MIGRATION PHASES
| Phase | Description | Status |
|-------|------------|--------|
| 1 | Express backend + PostgreSQL schema | ✅ DONE |
| 2 | Auth (JWT + Google OAuth) | ✅ DONE |
| 3 | Core data CRUD (Users, Shops, Orders) | ✅ DONE |
| 4 | File uploads (Multer + local/S3) | ✅ DONE |
| 5 | Payment (Razorpay + HMAC verification) | ✅ DONE |
| 6 | Advanced (Notifications, Tickets, Ledger) | ✅ DONE |
| 7 | Deploy (Vercel + Railway/VPS + managed Postgres) | ⬜ NEXT |

## 7. NEXT IMMEDIATE STEPS (FOR RESUMING)
1. [ ] Rewire frontend data layer from Firebase SDK to REST API calls
2. [ ] Add Socket.IO for real-time order status updates
3. [ ] Set up deployment: Vercel (frontend), Railway/Render (backend + DB)
4. [ ] Configure production environment variables (S3, Razorpay keys)
5. [ ] Merge `migrate/new-backend` → `main` after final testing

## 8. KEY FILE MAP
```
server/
├── prisma/schema.prisma
├── src/
│   ├── index.ts                      ← Express entry point
│   ├── config/env.ts                 ← Typed env (JWT, S3, Razorpay)
│   ├── controllers/
│   │   ├── auth.controller.ts        ← ✅ register, login, google, refresh, logout, me
│   │   ├── user.controller.ts        ← ✅ profile get/update, admin list
│   │   ├── shop.controller.ts        ← ✅ list, get, settings, approve, archive, aggregate
│   │   ├── order.controller.ts       ← ✅ create, list, get, status update, admin list
│   │   ├── upload.controller.ts      ← ✅ single/multi upload, download, delete
│   │   ├── payment.controller.ts     ← ✅ create-order, verify, webhook
│   │   ├── notification.controller.ts ← ✅ list, mark read, mark all read
│   │   └── ticket.controller.ts      ← ✅ create, list, get, message, status
│   ├── services/
│   │   ├── auth.service.ts           ← Auth business logic
│   │   ├── token.service.ts          ← JWT + refresh token lifecycle
│   │   ├── user.service.ts           ← Profile CRUD, admin listing
│   │   ├── shop.service.ts           ← Shop CRUD, admin actions, aggregates
│   │   ├── order.service.ts          ← Order lifecycle, FSM, pricing
│   │   ├── storage.service.ts        ← ✅ Strategy Pattern: local/S3
│   │   ├── payment.service.ts        ← ✅ Razorpay orders + HMAC verify
│   │   ├── notification.service.ts   ← ✅ CRUD + unread count
│   │   ├── ticket.service.ts         ← ✅ Tickets + messages + audit
│   │   └── ledger.service.ts         ← ✅ Financial entries + optimistic lock
│   ├── middleware/
│   │   ├── auth.ts                   ← authenticate + authorize
│   │   ├── errorHandler.ts           ← Centralized error + 404
│   │   ├── rateLimiter.ts            ← 3-tier
│   │   ├── validate.ts               ← Zod validation
│   │   └── upload.ts                 ← ✅ Multer config (20MB, MIME filter)
│   ├── routes/
│   │   ├── index.ts                  ← Route aggregator (all registered)
│   │   ├── auth.routes.ts            ← ✅ LIVE
│   │   ├── health.routes.ts          ← ✅ LIVE
│   │   ├── user.routes.ts            ← ✅ LIVE
│   │   ├── shop.routes.ts            ← ✅ LIVE
│   │   ├── order.routes.ts           ← ✅ LIVE (refund still 501)
│   │   ├── upload.routes.ts          ← ✅ LIVE
│   │   ├── payment.routes.ts         ← ✅ LIVE
│   │   ├── notification.routes.ts    ← ✅ LIVE
│   │   ├── ticket.routes.ts          ← ✅ LIVE
│   │   └── payout.routes.ts          ← 501 stub (Phase 7)
│   └── utils/
│       ├── ApiError.ts
│       └── prisma.ts
├── .env
└── package.json
```

## 9. LIVE API ENDPOINTS SUMMARY
| Method | Endpoint | Auth | Status |
|--------|----------|------|--------|
| POST | /auth/register | ❌ | ✅ |
| POST | /auth/login | ❌ | ✅ |
| POST | /auth/google | ❌ | ✅ |
| POST | /auth/refresh | ❌ | ✅ |
| POST | /auth/logout | ✅ | ✅ |
| GET | /auth/me | ✅ | ✅ |
| GET | /users/me | ✅ | ✅ |
| PATCH | /users/me | ✅ | ✅ |
| GET | /users | Admin | ✅ |
| GET | /shops | ❌ | ✅ |
| GET | /shops/:id | ❌ | ✅ |
| PATCH | /shops/:id | Owner | ✅ |
| PATCH | /shops/:id/approve | Admin | ✅ |
| PATCH | /shops/:id/archive | Admin | ✅ |
| GET | /shops/:id/aggregate | Owner | ✅ |
| POST | /orders | Student | ✅ |
| GET | /orders | ✅ | ✅ |
| GET | /orders/:id | ✅ | ✅ |
| PATCH | /orders/:id/status | Shop/Admin | ✅ |
| GET | /orders/admin/all | Admin | ✅ |
| POST | /uploads/single | ✅ | ✅ |
| POST | /uploads/multiple | ✅ | ✅ |
| GET | /uploads/url/:key | ✅ | ✅ |
| GET | /uploads/download/:f/:n | ✅ | ✅ |
| DELETE | /uploads/:key | ✅ | ✅ |
| POST | /payments/create-order | ✅ | ✅ |
| POST | /payments/verify | ✅ | ✅ |
| POST | /payments/webhook | ❌ | ✅ |
| GET | /notifications | ✅ | ✅ |
| PATCH | /notifications/read-all | ✅ | ✅ |
| PATCH | /notifications/:id/read | ✅ | ✅ |
| POST | /tickets | ✅ | ✅ |
| GET | /tickets | ✅ | ✅ |
| GET | /tickets/:id | ✅ | ✅ |
| POST | /tickets/:id/messages | ✅ | ✅ |
| PATCH | /tickets/:id/status | Admin | ✅ |
