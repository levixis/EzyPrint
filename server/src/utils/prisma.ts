import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

/**
 * Singleton Prisma client instance.
 *
 * In development, we attach it to `globalThis` to prevent creating
 * multiple connections during hot-reloads (tsx watch).
 *
 * Connection pool sizing lives in the DATABASE_URL query string, because that
 * is the only place Prisma reads it from — there is no client-side option for
 * it. It is currently unset in production, so Prisma falls back to its default
 * of `physical_cores * 2 + 1`; in a container `os.cpus()` frequently reports
 * the *host's* cores rather than the container's limit, which makes the real
 * pool size unknown rather than chosen. Setting it explicitly is worth doing
 * for that reason alone:
 *
 *     ?sslmode=require&connection_limit=10
 *
 * An earlier version of this comment justified a much smaller number on the
 * grounds that "there is no PgBouncer in front of this, so every pool slot is a
 * real Postgres connection". That was wrong, and wrong in a way worth recording
 * because it came from reading `server/.env` instead of the deployed
 * configuration. Production's DATABASE_URL is the Neon **-pooler** endpoint, so
 * Prisma's pool talks to PgBouncer, which multiplexes onto far fewer backend
 * connections. The "each slot costs a real connection" arithmetic does not
 * apply, and the Postgres ceiling is not what bounds this.
 *
 * What `connection_limit` actually governs here is how many queries this
 * process will have in flight against the pooler at once — backpressure, not a
 * connection budget. 10 matches what `.env.example` has always suggested.
 *
 * DIRECT_URL must stay the **non-pooler** endpoint. Migrations take
 * session-scoped locks, which transaction pooling cannot hold — the same
 * property that pushed the scheduler off advisory locks and onto a lease table.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isDev ? ['error', 'warn'] : ['error'],
  });

if (env.isDev) {
  globalForPrisma.prisma = prisma;
}
