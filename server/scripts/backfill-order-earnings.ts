/**
 * Credit shops for orders they completed before earnings-crediting existed.
 *
 * `creditOrderEarning` runs inside the transaction that moves an order to
 * COMPLETED. Orders that reached COMPLETED before that code shipped were never
 * credited and nothing retroactively fixes them, so those shops did the work
 * and were never paid. TestShop's order kjjg9e is one; any shop trading during
 * that window has the same hole.
 *
 * Safe to run repeatedly. It calls the same `creditOrderEarning` the live path
 * uses, whose `eventId` of `earn:<orderId>` is unique — a second run cannot
 * double-credit, because the duplicate insert violates the constraint and rolls
 * its own transaction back.
 *
 *   npx tsx scripts/backfill-order-earnings.ts            # report only
 *   npx tsx scripts/backfill-order-earnings.ts --apply    # write
 */

import { prisma } from '../src/utils/prisma';
import { creditOrderEarning } from '../src/services/settlement.service';

const APPLY = process.argv.includes('--apply');
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

async function main() {
  const completed = await prisma.order.findMany({
    where: { status: 'COMPLETED', pageCost: { gt: 0 } },
    select: { id: true, shopId: true, pageCost: true, completedAt: true, uploadedAt: true },
    orderBy: { uploadedAt: 'asc' },
  });

  const credited = await prisma.ledgerEntry.findMany({
    where: { type: 'ORDER_EARNING', orderId: { in: completed.map((o) => o.id) } },
    select: { orderId: true },
  });
  const already = new Set(credited.map((e) => e.orderId));

  const missing = completed.filter((o) => !already.has(o.id));

  console.log(`${completed.length} completed order(s), ${already.size} credited, ${missing.length} missing\n`);
  if (missing.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  for (const o of missing) {
    console.log(`  ${o.id.slice(-6)}  ${rupees(o.pageCost)}  shop ${o.shopId.slice(-6)}  completed ${o.completedAt?.toISOString() ?? 'unknown'}`);
  }
  console.log(`\n  total owed: ${rupees(missing.reduce((s, o) => s + o.pageCost, 0))}`);

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to write these.');
    return;
  }

  let ok = 0;
  for (const o of missing) {
    try {
      await prisma.$transaction(async (tx) => {
        // Completion time, not now — see the note on creditOrderEarning. Falls
        // back to upload time for rows predating completedAt being recorded.
        await creditOrderEarning(tx, o, o.completedAt ?? o.uploadedAt);
      });
      ok++;
      console.log(`  credited ${o.id.slice(-6)}`);
    } catch (error) {
      // One bad row must not strand the rest; the unique eventId means a retry
      // of the whole script is harmless.
      console.error(`  FAILED ${o.id.slice(-6)}:`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`\nCredited ${ok}/${missing.length}.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
