# AI STATE HANDOFF
> **STATUS**: Green | **LAST UPDATE**: 2026-07-26T23:31Z IST | **TESTS**: 73 unit + 61 integration = 134 total

## 1. METADATA & TECH STACK
* **Project Name**: EzyPrint — campus print-order marketplace (students → shops)
* **Core Stack**: React 19 + Vite 8 + TailwindCSS 3 (frontend) | Express 5 + Prisma 6 + PostgreSQL 15 (new backend) | TypeScript | Capacitor 8 (mobile)
* **Environment**: macOS, Node 25.2.1, PostgreSQL 15.15, port 5001 (backend), port 5173 (Vite)
* **Workspace**: `/Users/harshvardhanjha/Desktop/good code latest`
* **Git Branch**: `migrate/new-backend` — `main` untouched
* **DB**: `ezyprint` | User: `harshvardhanjha` (no pw)
* **Test users**: student (`test@ezyprint.com`/`Test1234!`), shop (`shop@ezyprint.com`/`Shop1234!`), admin (`admin@ezyprint.com`/`Admin1234!`)

## 2. COMPLETED WORK
* ✅ **Phase 1** — Express 5 + Prisma (18 tables, 15 enums)
* ✅ **Phase 2** — Auth: email/pass + Google OAuth + JWT rotation + replay detection
* ✅ **Phase 3** — Core CRUD: Users, Shops, Orders (FSM, pricing, access control)
* ✅ **Phase 4** — File uploads: Multer + Storage service (local/S3 Strategy Pattern)
* ✅ **Phase 5** — Payment: Razorpay orders, HMAC SHA-256 verification, webhook fallback
* ✅ **Phase 6** — Advanced: Notifications + Tickets + Ledger (optimistic concurrency)
* ✅ **Security Hardening** — Zod on ALL routes, XSS sanitization, path traversal blocking, password strength, security headers
* ✅ **Unit Tests** — Jest: 73/73 (pricing, FSM, validators, security middleware)
* ✅ **Integration Tests** — curl suite: 61 endpoints tested

## 3. SECURITY MEASURES
* **Input Validation**: Zod schemas on every route — type, length, format, enum
* **Password**: 8-72 chars, uppercase + lowercase + number + special char
* **XSS Prevention**: Server-side body sanitization (HTML, javascript:, event handlers)
* **Path Traversal**: Blocked in URL params (.. and %2e%2e)
* **Security Headers**: CSP, X-Frame-Options, Permissions-Policy, Referrer-Policy
* **Auth**: bcrypt (12 rounds) + JWT (15min) + refresh rotation + replay detection
* **Rate Limiting**: 3-tier (general 100/15min, auth 20/15min, sensitive 5/15min)
* **Stack traces**: Hidden in production (env.isDev check)
* **SQL Injection**: Prisma parameterized queries prevent injection
* **Email normalization**: Lowercase + trim prevents case-sensitivity exploits

## 4. TEST COMMANDS
```bash
npm test              # 73 unit tests (Jest)
bash test_suite.sh    # 61 integration tests (curl)
npm test -- --coverage # Coverage report
```

## 5. NEXT STEPS
1. [ ] Deploy to Railway/Render (Phase 7)
2. [ ] Rewire frontend from Firebase to REST API
3. [ ] Add Socket.IO for real-time order updates
