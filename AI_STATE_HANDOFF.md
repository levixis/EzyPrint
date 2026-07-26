# AI STATE HANDOFF
> **STATUS**: Green | **LAST UPDATE**: 2026-07-26T22:48Z IST

## 1. METADATA & TECH STACK
* **Project Name**: EzyPrint — campus print-order marketplace (students → shops)
* **Core Stack**: React 19 + Vite 8 + TailwindCSS 3 (frontend) | Express 5 + Prisma 6 + PostgreSQL 15 (new backend) | TypeScript everywhere | Capacitor 8 (mobile)
* **Environment**: macOS, Node 25.2.1, npm 11.7.0, PostgreSQL 15.15 (Homebrew), port 5001 (backend), port 5173 (Vite frontend)
* **Workspace**: `/Users/harshvardhanjha/Desktop/good code latest`
* **Git Branch**: `migrate/new-backend` (active) — `main` untouched
* **DB**: `ezyprint` | User: `harshvardhanjha` (no password) | URL: `postgresql://harshvardhanjha@localhost:5432/ezyprint?schema=public`

## 2. ARCHITECTURE OVERVIEW
Frontend (React+Vite+Tailwind+Capacitor) at workspace root stays mostly unchanged — data layer will be rewired from Firebase SDK to REST/WebSocket calls. New Express backend in `server/` with layered architecture: Routes → Controllers → Services → Prisma ORM → PostgreSQL (18 tables). Auth uses stateless JWT access tokens (15min) + server-side hashed refresh tokens (7d) with rotation and replay detection.

## 3. COMPLETED WORK
* ✅ **Phase 1** — Express 5 backend + Prisma schema (18 tables, 15 enums, all FK relations)
* ✅ **Phase 2** — Full authentication system:
  - Email/password register + login (bcrypt, 12 rounds)
  - Google OAuth (server-side token verification via Google tokeninfo API)
  - JWT access tokens (15min, stateless) + refresh tokens (7d, SHA-256 hashed in DB)
  - Refresh token rotation with replay attack detection (revokes all sessions on reuse)
  - Role-based authorization middleware (`authenticate` + `authorize('ADMIN')`)
  - 9/9 test cases passing: register, login, profile, refresh, replay detection, shop owner reg, duplicate email, wrong password, no auth header

## 4. IN-PROGRESS & CURRENT BLOCKERS
* **Active Phase**: Phase 3 — Core Data CRUD (NOT STARTED)
* **Active File(s)**: None — Phase 2 just completed
* **Current Error/Bug**: None
* **Blocker**: None

## 5. HARD CODING RULES & DECISIONS
* No Google/Firebase — full MERN+PostgreSQL migration
* Layered: Routes → Controllers → Services → Prisma
* Auth: Pure bcrypt + JWT (no Passport.js) — interview-explainable
* Google OAuth: Frontend sends ID token → backend verifies via `oauth2.googleapis.com/tokeninfo`
* Token strategy: Access (JWT, 15min, stateless) + Refresh (random 80-char hex, SHA-256 hashed, DB-stored, 7d, rotation with replay detection)
* File storage: Cloudflare R2 / AWS S3 (Phase 4)
* Real-time: Socket.IO (Phase 3)
* Port: 5001 (5000 blocked by AirPlay)
* API: `/api/v1/` prefix
* Validation: Zod | Errors: `ApiError` class | Rate limiting: 3-tier

## 6. MIGRATION PHASES
| Phase | Description | Status |
|-------|------------|--------|
| 1 | Express backend + PostgreSQL schema | ✅ DONE |
| 2 | Auth (JWT + Google OAuth) | ✅ DONE |
| 3 | Core data CRUD (Users, Shops, Orders) + Socket.IO | ⬜ NEXT |
| 4 | File uploads (Multer + S3/R2) | ⬜ |
| 5 | Payment (Razorpay webhook in Express) | ⬜ |
| 6 | Advanced (Notifications, Ledger, Tickets, Cron) | ⬜ |
| 7 | Deploy (Vercel + Railway/VPS + managed Postgres) | ⬜ |

## 7. NEXT IMMEDIATE STEPS (FOR RESUMING)
1. [ ] Create `server/src/services/shop.service.ts` — CRUD for shops
2. [ ] Create `server/src/services/order.service.ts` — order lifecycle
3. [ ] Create `server/src/services/user.service.ts` — profile management
4. [ ] Create controllers for each service
5. [ ] Replace 501 stubs in shop/order/user routes with real handlers
6. [ ] Add Socket.IO for real-time order status updates
7. [ ] Add Zod validation schemas for all request bodies

## 8. KEY FILE MAP
```
server/
├── prisma/schema.prisma              ← 15 models (incl RefreshToken), 15 enums
├── src/
│   ├── index.ts                      ← Express entry point
│   ├── config/env.ts                 ← Typed env config
│   ├── controllers/
│   │   └── auth.controller.ts        ← register, login, google, refresh, logout, me
│   ├── services/
│   │   ├── auth.service.ts           ← Auth business logic (register, login, Google OAuth)
│   │   └── token.service.ts          ← JWT + refresh token lifecycle
│   ├── middleware/
│   │   ├── auth.ts                   ← authenticate + authorize middleware
│   │   ├── errorHandler.ts           ← Centralized error + 404
│   │   ├── rateLimiter.ts            ← 3-tier (general/auth/sensitive)
│   │   └── validate.ts              ← Zod validation
│   ├── routes/
│   │   ├── index.ts                  ← Route aggregator
│   │   ├── auth.routes.ts            ← ✅ LIVE: register/login/google/refresh/logout/me
│   │   ├── health.routes.ts          ← ✅ LIVE: DB connectivity check
│   │   ├── user.routes.ts            ← 501 stubs
│   │   ├── shop.routes.ts            ← 501 stubs
│   │   ├── order.routes.ts           ← 501 stubs
│   │   ├── payout.routes.ts          ← 501 stubs
│   │   ├── ticket.routes.ts          ← 501 stubs
│   │   └── notification.routes.ts    ← 501 stubs
│   └── utils/
│       ├── ApiError.ts               ← Custom error class
│       └── prisma.ts                 ← Singleton PrismaClient
├── .env                              ← Local config
└── package.json                      ← Express 5, Prisma, JWT, bcrypt, Zod
```
