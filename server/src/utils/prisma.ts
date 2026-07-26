import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

/**
 * Singleton Prisma client instance.
 *
 * In development, we attach it to `globalThis` to prevent creating
 * multiple connections during hot-reloads (tsx watch).
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isDev ? ['query', 'error', 'warn'] : ['error'],
  });

if (env.isDev) {
  globalForPrisma.prisma = prisma;
}
