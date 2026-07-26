# AI STATE HANDOFF
> **STATUS**: Green | **LAST UPDATE**: 2026-07-26T22:58Z IST

## 1. METADATA & TECH STACK
* **Project Name**: EzyPrint — campus print-order marketplace (students → shops)
* **Core Stack**: React 19 + Vite 8 + TailwindCSS 3 (frontend) | Express 5 + Prisma 6 + PostgreSQL 15 (new backend) | TypeScript | Capacitor 8 (mobile)
* **Environment**: macOS, Node 25.2.1, PostgreSQL 15.15, port 5001 (backend), port 5173 (Vite)
* **Workspace**: `/Users/harshvardhanjha/Desktop/good code latest`
* **Git Branch**: `migrate/new-backend` — `main` untouched
* **DB**: `ezyprint` | User: `harshvardhanjha` (no pw) | URL: `postgresql://harshvardhanjha@localhost:5432/ezyprint?schema=public`
* **Test users in DB**: student (`test@ezyprint.com` / `Test1234!`), shop (`shop@ezyprint.com` / `Shop1234!`), admin (`admin@ezyprint.com` / `Admin1234!` — manually set type=ADMIN in DB)

## 2. ARCHITECTURE OVERVIEW
Frontend (React+Vite+Tailwind+Capacitor) at workspace root — data layer will be rewired from Firebase SDK to REST calls. New Express backend in `server/` with layered architecture: Routes → Controllers → Services → Prisma → PostgreSQL (18 tables). Auth: stateless JWT access tokens (15min) + hashed refresh tokens (7d) with rotation. Order system uses FSM (finite state machine) for status transitions.

## 3. COMPLETED WORK
* ✅ **Phase 1** — Express 5 + Prisma schema (18 tables, 15 enums, all FK relations)
* ✅ **Phase 2** — Auth: email/password + Google OAuth + JWT with refresh token rotation + replay detection
* ✅ **Phase 3** — Core CRUD:
  - User service: profile get/update, admin listing with pagination + search
  - Shop service: student listing (approved only), admin listing, settings update with ownership check, approve/archive, aggregate stats with upsert cache
  - Order service: create with pricing calc + pickup code, role-aware listing (student/shop/admin), status FSM with transition validation, access control
  - All controllers + routes live (user/shop/order stubs replaced)
  - 10/10 tests passing

## 4. IN-PROGRESS & CURRENT BLOCKERS
* **Active Phase**: Phase 4 — File Uploads (NOT STARTED)
* **Active File(s)**: None — Phase 3 just completed
* **Current Error/Bug**: None
* **Blocker**: None

## 5. HARD CODING RULES & DECISIONS
* No Google/Firebase — full MERN+PostgreSQL migration
* Layered: Routes → Controllers → Services → Prisma
* Auth: Pure bcrypt + JWT (no Passport.js)
* Order status FSM: PENDING_PAYMENT→PENDING_APPROVAL→PRINTING→READY_FOR_PICKUP→COMPLETED. Side: CANCELLED, PAYMENT_FAILED, REFUNDED
* Base fee: ≤5→₹2, ≤20→₹3, ≤50→₹5, >50→10%
* Token: Access (JWT 15min) + Refresh (80-char hex, SHA-256 hashed, 7d, rotation)
* Port: 5001 | API: `/api/v1/` | Validation: Zod | Errors: `ApiError`

## 6. MIGRATION PHASES
| Phase | Description | Status |
|-------|------------|--------|
| 1 | Express backend + PostgreSQL schema | ✅ DONE |
| 2 | Auth (JWT + Google OAuth) | ✅ DONE |
| 3 | Core data CRUD (Users, Shops, Orders) | ✅ DONE |
| 4 | File uploads (Multer + S3/R2) | ⬜ NEXT |
| 5 | Payment (Razorpay webhook in Express) | ⬜ |
| 6 | Advanced (Notifications, Ledger, Tickets, Cron) | ⬜ |
| 7 | Deploy (Vercel + Railway/VPS + managed Postgres) | ⬜ |

## 7. NEXT IMMEDIATE STEPS (FOR RESUMING)
1. [ ] Install `multer`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
2. [ ] Create `server/src/services/storage.service.ts` — S3/R2 upload + pre-signed URLs
3. [ ] Create `server/src/controllers/upload.controller.ts`
4. [ ] Create `server/src/routes/upload.routes.ts` — POST /upload, GET /download/:key
5. [ ] Add Multer middleware for multipart form-data
6. [ ] Wire file storage path into order creation flow
7. [ ] Add Socket.IO to `server/src/index.ts` for real-time order updates (deferred from Phase 3)

## 8. KEY FILE MAP
```
server/
├── prisma/schema.prisma              ← 16 models (incl RefreshToken), 15 enums
├── src/
│   ├── index.ts                      ← Express entry point
│   ├── config/env.ts                 ← Typed env config
│   ├── controllers/
│   │   ├── auth.controller.ts        ← register, login, google, refresh, logout, me
│   │   ├── user.controller.ts        ← ✅ profile get/update, admin list
│   │   ├── shop.controller.ts        ← ✅ list, get, settings, approve, archive, aggregate
│   │   └── order.controller.ts       ← ✅ create, list, get, status update, admin list
│   ├── services/
│   │   ├── auth.service.ts           ← Auth business logic
│   │   ├── token.service.ts          ← JWT + refresh token lifecycle
│   │   ├── user.service.ts           ← ✅ Profile CRUD, admin listing
│   │   ├── shop.service.ts           ← ✅ Shop CRUD, admin actions, aggregates
│   │   └── order.service.ts          ← ✅ Order lifecycle, FSM, pricing
│   ├── middleware/
│   │   ├── auth.ts                   ← authenticate + authorize
│   │   ├── errorHandler.ts           ← Centralized error + 404
│   │   ├── rateLimiter.ts            ← 3-tier
│   │   └── validate.ts              ← Zod validation
│   ├── routes/
│   │   ├── index.ts                  ← Route aggregator
│   │   ├── auth.routes.ts            ← ✅ LIVE
│   │   ├── health.routes.ts          ← ✅ LIVE
│   │   ├── user.routes.ts            ← ✅ LIVE
│   │   ├── shop.routes.ts            ← ✅ LIVE
│   │   ├── order.routes.ts           ← ✅ LIVE (payment/refund still 501)
│   │   ├── payout.routes.ts          ← 501 stubs
│   │   ├── ticket.routes.ts          ← 501 stubs
│   │   └── notification.routes.ts    ← 501 stubs
│   └── utils/
│       ├── ApiError.ts               ← Custom error class
│       └── prisma.ts                 ← Singleton PrismaClient
├── .env                              ← Local config
└── package.json
```
