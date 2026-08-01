const fs = require('fs');
const file = 'src/routes/refund.routes.ts';
let code = fs.readFileSync(file, 'utf8');

const regex = /\/\/ APPROVE flow -> Segregated transaction[\s\S]*?let razorpayRefundId = request\.razorpayRefundId;/;
const replacement = `// APPROVE flow -> Segregated transaction
    const initialRequest = await prisma.refundRequest.findUnique({ where: { id }, include: { order: true } });
    if (!initialRequest) throw ApiError.notFound();
    
    const requestedAmount = refundAmount || initialRequest.order.totalPrice;
    if (requestedAmount > initialRequest.order.totalPrice) {
      throw ApiError.badRequest('Refund cannot exceed order total');
    }
    
    if (initialRequest.status === 'PROCESSING_REFUND' && initialRequest.refundAmount && initialRequest.refundAmount !== requestedAmount) {
      throw ApiError.badRequest('Cannot change refund amount for a request that is already processing');
    }

    // 1. Claim
    const claim = await prisma.refundRequest.updateMany({
      where: { id, status: { in: ['ESCALATED_TO_ADMIN', 'APPROVED_BY_SHOP', 'AUTO_ESCALATED', 'PROCESSING_REFUND'] } },
      data: { status: 'PROCESSING_REFUND', refundAmount: requestedAmount, adminNote: adminNote || initialRequest.adminNote }
    });
    if (claim.count === 0) throw ApiError.badRequest('Refund request not found or invalid state');

    const request = await prisma.refundRequest.findUnique({ where: { id }, include: { order: true } });
    if (!request) throw ApiError.notFound();

    let razorpayRefundId = request.razorpayRefundId;`;

code = code.replace(regex, replacement);

const amountRegex = /const amount = refundAmount \|\| request\.order\.totalPrice;/;
code = code.replace(amountRegex, `const amount = request.refundAmount || request.order.totalPrice;`);

fs.writeFileSync(file, code);
