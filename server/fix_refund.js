const fs = require('fs');
const file = 'src/routes/refund.routes.ts';
let code = fs.readFileSync(file, 'utf8');

const targetBlock = `    // 3. Persist
    const result = await prisma.$transaction(async (tx) => {
      const updatedRequest = await tx.refundRequest.update({
        where: { id },
        data: {
          status: finalStatus as any,
          adminNote,
          resolvedBy: req.user?.userId,
          adminResolvedAt: new Date(),
          refundAmount: amount,
          razorpayRefundId,
        }
      });
      
      await tx.order.update({
        where: { id: request.orderId },
        data: { status: 'REFUNDED' }
      });

      await ledgerService.createLedgerEntry({
        shopId: request.shopId,
        type: 'REFUND_DEDUCTION',
        amount: amount,
        description: \`Refund for order \${request.orderId}\`,
        counterparty: 'STUDENT',
        createdBy: 'ADMIN',
        orderId: request.orderId,
      }, tx);

      return updatedRequest;
    });`;

const replacement = `    // 3. Persist
    const result = await prisma.$transaction(async (tx) => {
      const updatedRequestCount = await tx.refundRequest.updateMany({
        where: { id, status: 'PROCESSING_REFUND' },
        data: {
          status: finalStatus as any,
          adminNote,
          resolvedBy: req.user?.userId,
          adminResolvedAt: new Date(),
          refundAmount: amount,
          razorpayRefundId,
        }
      });
      
      if (updatedRequestCount.count === 0) {
        throw ApiError.badRequest('Refund already processed or invalid state');
      }

      await tx.order.updateMany({
        where: { id: request.orderId },
        data: { status: 'REFUNDED' }
      });

      await ledgerService.createLedgerEntry({
        shopId: request.shopId,
        type: 'REFUND_DEDUCTION',
        amount: amount,
        description: \`Refund for order \${request.orderId}\`,
        counterparty: 'STUDENT',
        createdBy: 'ADMIN',
        orderId: request.orderId,
        eventId: \`refund:\${request.id}\`
      }, tx);

      return tx.refundRequest.findUnique({ where: { id } });
    });`;

code = code.replace(targetBlock, replacement);
fs.writeFileSync(file, code);
