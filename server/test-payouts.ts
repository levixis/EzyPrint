import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function run() {
  try {
    const payouts = await prisma.payout.findMany({
      where: {},
      take: 100,
      orderBy: { createdAt: 'desc' }
    });
    console.log("SUCCESS:", payouts.length);
  } catch (err) {
    console.error("ERROR:", err);
  } finally {
    await prisma.$disconnect();
  }
}
run();
