# AI STATE HANDOFF
> **STATUS**: Green | **LAST UPDATE**: 2026-07-26T22:43Z IST

## 1. METADATA & TECH STACK
* **Project Name**: EzyPrint — campus print-order marketplace (students → shops)
* **Core Stack**: React 19 + Vite 8 + TailwindCSS 3 (frontend) | Express 5 + Prisma 6 + PostgreSQL 15 (new backend) | TypeScript everywhere | Capacitor 8 (mobile)
* **Environment Constraints**: macOS, Node 25.2.1, npm 11.7.0, PostgreSQL 15.15 (Homebrew), port 5001 (backend, 5000 blocked by AirPlay), port 5173 (Vite frontend)
* **Workspace Root**: `/Users/harshvardhanjha/Desktop/good code latest`
* **Git Branch**: `migrate/new-backend` (active) — `main` is untouched/stable
* **Backup**: `/Users/harshvardhanjha/Desktop/good code latest - BACKUP/` (full copy minus node_modules/.git)
* **DB Name**: `ezyprint` | **DB User**: `harshvardhanjha` (no password, macOS peer auth)
* **DB URL**: `postgresql://harshvardhanjha@localhost:5432/ezyprint?schema=public`

## 2. ARCHITECTURE OVERVIEW
EzyPrint was originally a Firebase-only app (Auth, Firestore, Storage, Cloud Functions, FCM, Hosting). We are migrating to MERN+PostgreSQL so the developer can explain every layer in interviews. The frontend (React+Vite+Tailwind+Capacitor) lives at workspace root and remains mostly unchanged — only the data/auth layer will be rewired from Firebase SDK calls to REST/WebSocket calls to the new Express backend. The new backend lives in `server/` with layered architecture: Routes → Controllers → Services → Prisma ORM → PostgreSQL.

## 3. COMPLETED WORK
* ✅ **Backup** created at `good code latest - BACKUP/`
* ✅ **Git branch** `migrate/new-backend` created from clean `main`
* ✅ **Phase 1 COMPLETE** — Express backend + PostgreSQL schema
  - `server/` directory with 23 files committed
  - Prisma schema: 14 models, 15 native PG enums, all FK relations, composite indexes
  - 17 PostgreSQL tables created and verified via `psql`
  - Express 5 server with: Helmet, CORS, Morgan, JSON parsing, rate limiting
  - Middleware: JWT auth (skeleton), centralized error handler, Zod validation, 3-tier rate limiter
  - 8 route modules: health, auth, users, shops, orders, payouts, tickets, notifications
  - Health check verified: `GET /api/v1/health` → `{ status: "ok", database: "connected" }`
  - All route stubs return 501 with phase indicator
  - Committed: `b98c771` on `migrate/new-backend`

## 4. IN-PROGRESS & CURRENT BLOCKERS
* **Active Phase**: Phase 2 — Authentication (NOT STARTED)
* **Active File(s)**: None yet — Phase 1 just completed cleanly
* **Current Error/Bug**: None — server runs, DB connects, all tests pass
* **Blocker**: None

## 5. HARD CODING RULES & DECISIONS
* **No Google/Firebase services** — entire migration away from Firebase ecosystem
* **Layered architecture**: Routes → Controllers → Services → Prisma (repository pattern)
* **Auth**: Passport.js + JWT (access + refresh tokens), bcrypt for passwords, Google OAuth via `passport-google-oauth20`
* **File storage**: Cloudflare R2 or AWS S3 (Phase 4) — NOT Firebase Storage
* **Push notifications**: OneSignal or web-push — NOT FCM
* **Real-time**: Socket.IO — replaces Firestore `onSnapshot`
* **Scheduled jobs**: node-cron or BullMQ — replaces Cloud Functions `onSchedule`
* **API versioning**: `/api/v1/` prefix
* **Validation**: Zod schemas
* **Error handling**: `ApiError` class with factory methods (`ApiError.notFound()`, etc.)
* **Prisma client**: Singleton via `globalThis` to survive hot-reloads
* **Port**: 5001 (not 5000 — macOS AirPlay conflict)
* **Frontend stays React+Vite+Tailwind+Capacitor** — only data layer changes

## 6. MIGRATION PHASES (ROADMAP)
| Phase | Description | Status |
|-------|------------|--------|
| 1 | Express backend + PostgreSQL schema (Prisma) | ✅ DONE |
| 2 | Auth (Passport.js + JWT + Google OAuth) | ⬜ NEXT |
| 3 | Core data CRUD (Users, Shops, Orders) + Socket.IO real-time | ⬜ |
| 4 | File uploads (Multer + S3/R2) | ⬜ |
| 5 | Payment (Razorpay webhook in Express) | ⬜ |
| 6 | Advanced (Notifications, Ledger, Tickets, Cron jobs) | ⬜ |
| 7 | Deploy (Vercel + Railway/VPS + managed Postgres) | ⬜ |

## 7. NEXT IMMEDIATE STEPS (FOR RESUMING)
1. [ ] Implement Phase 2 — Auth system in `server/src/`
2. [ ] Install `passport`, `passport-google-oauth20`, `passport-local`
3. [ ] Create `server/src/services/auth.service.ts` — register, login, Google OAuth, token generation
4. [ ] Create `server/src/controllers/auth.controller.ts` — request handlers
5. [ ] Implement real JWT logic in `server/src/middleware/auth.ts` (currently skeleton)
6. [ ] Fill in `server/src/routes/auth.routes.ts` (currently returns 501 stubs)
7. [ ] Add refresh token rotation + httpOnly cookie strategy
8. [ ] Test: register → login → access protected route → refresh → logout

## 8. KEY FILE MAP
```
server/
├── prisma/schema.prisma          ← 14 models, 15 enums, all relations
├── src/
│   ├── index.ts                  ← Express entry (helmet, cors, morgan, routes, error handler)
│   ├── config/env.ts             ← Typed env config
│   ├── middleware/
│   │   ├── auth.ts               ← JWT verify + authorize('ADMIN') role guard
│   │   ├── errorHandler.ts       ← Centralized catch-all + 404
│   │   ├── rateLimiter.ts        ← general(100) / auth(20) / sensitive(10) per 15min
│   │   └── validate.ts           ← Zod schema middleware
│   ├── routes/
│   │   ├── index.ts              ← Aggregator → /api/v1/*
│   │   ├── health.routes.ts      ← GET /health (DB ping)
│   │   ├── auth.routes.ts        ← POST register/login/google/refresh/logout (501 stubs)
│   │   ├── user.routes.ts        ← GET/PATCH /me, GET / (admin)
│   │   ├── shop.routes.ts        ← CRUD + approve/archive
│   │   ├── order.routes.ts       ← CRUD + status + verify-payment + refund
│   │   ├── payout.routes.ts      ← CRUD + ledger
│   │   ├── ticket.routes.ts      ← CRUD + messages + status
│   │   └── notification.routes.ts← GET / + PATCH read/read-all
│   └── utils/
│       ├── ApiError.ts           ← Custom error (400/401/403/404/409/429/500)
│       └── prisma.ts             ← Singleton PrismaClient
├── .env                          ← Local config (port 5001, DB URL, JWT secrets)
├── .env.example                  ← Template
├── package.json                  ← Express 5, Prisma, JWT, Zod, Helmet, Morgan
└── tsconfig.json                 ← ES2022, strict, commonjs
```
