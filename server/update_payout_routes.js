const fs = require('fs');
const file = 'src/routes/payout.routes.ts';
let code = fs.readFileSync(file, 'utf8');

// Imports
code = code.replace(
  "import { requestPayoutSchema } from '../validators/schemas';",
  "import { requestPayoutSchema, actionPayoutSchema, manualPayoutSchema } from '../validators/schemas';"
);

// Request
code = code.replace(
  "if (!shop) throw ApiError.notFound('Shop not found');",
  "if (!shop) throw ApiError.notFound('Shop not found');\n    if (shop.pendingBalance < amount) throw ApiError.badRequest('Insufficient pending balance');"
);

// Approve
code = code.replace(
  "router.post('/:id/approve', authenticate, authorize('ADMIN'), async (req, res, next) => {",
  "router.post('/:id/approve', authenticate, authorize('ADMIN'), validate(actionPayoutSchema), async (req, res, next) => {"
);
code = code.replace(
  /const payout = await tx\.payout\.findUnique[\s\S]*?if \(payout\.status !== 'PENDING'\)[\s\S]*?const updated = await tx\.payout\.update\(\{[\s\S]*?where: \{ id: payout\.id \},[\s\S]*?data: \{ status: 'PAID', adminNote, paidAt: new Date\(\) \}[\s\S]*?\}\);/,
  `const updated = await tx.payout.updateMany({
        where: { id: req.params.id as string, status: 'PENDING' },
        data: { status: 'PAID', adminNote, paidAt: new Date() }
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout not found or invalid state');
      const payout = await tx.payout.findUnique({ where: { id: req.params.id as string } });`
);

// Reject
code = code.replace(
  "router.post('/:id/reject', authenticate, authorize('ADMIN'), async (req, res, next) => {",
  "router.post('/:id/reject', authenticate, authorize('ADMIN'), validate(actionPayoutSchema), async (req, res, next) => {"
);
code = code.replace(
  /const payout = await tx\.payout\.findUnique[\s\S]*?if \(payout\.status !== 'PENDING'\)[\s\S]*?const updated = await tx\.payout\.update\(\{[\s\S]*?where: \{ id: payout\.id \},[\s\S]*?data: \{ status: 'REJECTED', adminNote \}[\s\S]*?\}\);[\s\S]*?const entry = await tx\.ledgerEntry\.findFirst[\s\S]*?if \(entry\) \{[\s\S]*?await tx\.ledgerEntry\.update[\s\S]*?where: \{ id: entry\.id \}, data: \{ status: 'VOID' \} \}\);/,
  `const payout = await tx.payout.findUnique({ where: { id: req.params.id as string } });
      if (!payout) throw ApiError.notFound('Payout not found');
      
      const updated = await tx.payout.updateMany({
        where: { id: payout.id, status: 'PENDING' },
        data: { status: 'REJECTED', adminNote }
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout status changed concurrently');

      const entryUpdate = await tx.ledgerEntry.updateMany({ where: { eventId: \`payout:\${payout.id}:reservation\`, status: 'PENDING' }, data: { status: 'VOID' } });
      if (entryUpdate.count === 0) throw ApiError.badRequest('Reservation ledger entry not found or invalid state');
      if (entryUpdate.count > 0) {`
);

// Cancel
code = code.replace(
  /if \(payout\.status !== 'PENDING'\)[\s\S]*?const updated = await tx\.payout\.update\(\{[\s\S]*?where: \{ id: payout\.id \},[\s\S]*?data: \{ status: 'CANCELLED' \}[\s\S]*?\}\);[\s\S]*?const entry = await tx\.ledgerEntry\.findFirst[\s\S]*?if \(entry\) \{[\s\S]*?await tx\.ledgerEntry\.update[\s\S]*?where: \{ id: entry\.id \}, data: \{ status: 'VOID' \} \}\);/,
  `const updated = await tx.payout.updateMany({
        where: { id: payout.id, status: 'PENDING' },
        data: { status: 'CANCELLED' }
      });
      if (updated.count === 0) throw ApiError.badRequest('Payout status changed concurrently');

      const entryUpdate = await tx.ledgerEntry.updateMany({ where: { eventId: \`payout:\${payout.id}:reservation\`, status: 'PENDING' }, data: { status: 'VOID' } });
      if (entryUpdate.count === 0) throw ApiError.badRequest('Reservation ledger entry not found or invalid state');
      if (entryUpdate.count > 0) {`
);

// Confirm
code = code.replace(
  /if \(payout\.status !== 'PAID'\)[\s\S]*?const updated = await prisma\.payout\.update\(\{[\s\S]*?where: \{ id: req\.params\.id as string \},[\s\S]*?data: \{ status: 'CONFIRMED', confirmedAt: new Date\(\) \}[\s\S]*?\}\);/,
  `const updated = await prisma.payout.updateMany({
      where: { id: req.params.id as string, status: 'PAID' },
      data: { status: 'CONFIRMED', confirmedAt: new Date() }
    });
    if (updated.count === 0) throw ApiError.badRequest('Payout not found or invalid state');`
);

// Dispute
code = code.replace(
  /if \(payout\.status !== 'PAID'\)[\s\S]*?const updated = await prisma\.payout\.update\(\{[\s\S]*?where: \{ id: req\.params\.id as string \},[\s\S]*?data: \{ status: 'DISPUTED', shopOwnerNote \}[\s\S]*?\}\);/,
  `const updated = await prisma.payout.updateMany({
      where: { id: req.params.id as string, status: 'PAID' },
      data: { status: 'DISPUTED', shopOwnerNote }
    });
    if (updated.count === 0) throw ApiError.badRequest('Payout not found or invalid state');`
);

// Manual
code = code.replace(
  "router.post('/manual', authenticate, authorize('ADMIN'), async (req, res, next) => {",
  "router.post('/manual', authenticate, authorize('ADMIN'), validate(manualPayoutSchema), async (req, res, next) => {"
);

fs.writeFileSync(file, code);
