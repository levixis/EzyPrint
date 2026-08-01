import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

/**
 * Singleton Prisma client instance.
 *
 * In development, we attach it to `globalThis` to prevent creating
 * multiple connections during hot-reloads (tsx watch).
 *
 * Connection pool is tuned for Neon free-tier (max 20 connections).
 * The connection_limit and pool_timeout are set via the DATABASE_URL
 * query parameters. Here we just reduce log noise.
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
