const fs = require('fs');
const file = 'src/routes/payout.routes.ts';
let code = fs.readFileSync(file, 'utf8');

// Fix getShopOwnerId
code = code.replace(
  `  if (!shop) throw ApiError.notFound('Shop not found');
    if (shop.pendingBalance < amount) throw ApiError.badRequest('Insufficient pending balance');
  return shop.ownerUserId;`,
  `  if (!shop) throw ApiError.notFound('Shop not found');
  return shop.ownerUserId;`
);

// Fix approve / reject mixup
const approveRejectMix = `      const updated = await tx.payout.updateMany({
        where: { id: req.params.id as string, status: 'PENDING' },
        data: { status: 'PAID', adminNote, paidAt: new Date() }
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout not found or invalid state');
      const payout = await tx.payout.findUnique({ where: { id: req.params.id as string } });
      if (!payout) throw ApiError.notFound('Payout not found');
      
      const updated = await tx.payout.updateMany({
        where: { id: payout.id, status: 'PENDING' },
        data: { status: 'REJECTED', adminNote }
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout status changed concurrently');

      const entryUpdate = await tx.ledgerEntry.updateMany({ where: { eventId: \`payout:\${payout.id}:reservation\`, status: 'PENDING' }, data: { status: 'VOID' } });
      if (entryUpdate.count === 0) throw ApiError.badRequest('Reservation ledger entry not found or invalid state');
      if (entryUpdate.count > 0) {
        
        await ledgerService.createLedgerEntry({
          shopId: payout.shopId,
          type: 'PAYOUT_REJECT_REFUND',
          amount: payout.amount,
          description: 'Payout request rejected refund',
          counterparty: 'PLATFORM',
          createdBy: 'ADMIN',
          eventId: \`payout:\${payout.id}:rejected\`
        }, tx);
      }

      return updated;`;

const correctSplit = `      const updated = await tx.payout.updateMany({
        where: { id: req.params.id as string, status: 'PENDING' },
        data: { status: 'PAID', adminNote, paidAt: new Date() }
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout not found or invalid state');
      
      const payout = await tx.payout.findUnique({ where: { id: req.params.id as string } });
      if (!payout) throw ApiError.notFound('Payout not found');

      const entryUpdate = await tx.ledgerEntry.updateMany({ 
        where: { eventId: \`payout:\${payout.id}:reservation\`, status: 'PENDING' }, 
        data: { status: 'SETTLED' } 
      });

      return payout;
    });

    res.json({ success: true, data: result });
  } catch (error) { next(error); }
});

router.post('/:id/reject', authenticate, authorize('ADMIN'), validate(actionPayoutSchema), async (req, res, next) => {
  try {
    const { adminNote } = req.body;
    
    const result = await prisma.$transaction(async (tx) => {
      const payout = await tx.payout.findUnique({ where: { id: req.params.id as string } });
      if (!payout) throw ApiError.notFound('Payout not found');
      
      const updated = await tx.payout.updateMany({
        where: { id: payout.id, status: 'PENDING' },
        data: { status: 'REJECTED', adminNote }
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout status changed concurrently');

      const entryUpdate = await tx.ledgerEntry.updateMany({ where: { eventId: \`payout:\${payout.id}:reservation\`, status: 'PENDING' }, data: { status: 'VOID' } });
      if (entryUpdate.count === 0) throw ApiError.badRequest('Reservation ledger entry not found or invalid state');
      
      await ledgerService.createLedgerEntry({
        shopId: payout.shopId,
        type: 'PAYOUT_REJECT_REFUND',
        amount: payout.amount,
        description: 'Payout request rejected refund',
        counterparty: 'PLATFORM',
        createdBy: 'ADMIN',
        eventId: \`payout:\${payout.id}:rejected\`
      }, tx);

      return payout;`;

// Let's replace precisely by string since I have the exact block.
// Wait, regex might fail due to newline characters differing.
// I will use replace with string.

const safeReplace = code.split(approveRejectMix.split('\\n')[0].trim())
let patchedCode = code;

if (patchedCode.includes('const updated = await tx.payout.updateMany({\\n        where: { id: payout.id, status: \\'PENDING\\' },\\n        data: { status: \\'REJECTED\\', adminNote }\\n      });')) {
    console.log("Found inner replace block");
}
