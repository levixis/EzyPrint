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
 * it. Set it there in the host environment:
 *
 *     ?sslmode=require&connection_limit=5&pool_timeout=10
 *
 * This comment previously asserted those parameters were already set. They were
 * not: the URL carried only `sslmode=require`, so Prisma fell back to its
 * default of `physical_cores * 2 + 1`. In a container `os.cpus()` frequently
 * reports the *host's* cores rather than the container's limit, so the real
 * pool size was both unintended and unknown.
 *
 * Why 5, given there is no PgBouncer in front of this — every pool slot is a
 * real Postgres connection:
 *
 *  - Measured need is far below it. Even at the old polling rate the whole app
 *    ran at ~9 requests/second, which is under one connection busy on average.
 *  - The pool is per Node process, so N instances cost N x 5. Five leaves room
 *    to run three instances inside the 20-connection budget this project has
 *    always assumed for the Neon tier.
 *  - The failure that actually hurts is starvation, not saturation: `start` is
 *    `prisma migrate deploy && node dist/index.js`, so a deploy needs a free
 *    connection. A pool that can eat the whole ceiling can lock out the next
 *    deploy, and the fix for that is a database you can no longer reach.
 *
 * `pool_timeout=10` is the default stated explicitly, so the next person can
 * see it rather than having to know it.
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
