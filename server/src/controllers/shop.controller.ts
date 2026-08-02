import { Request, Response, NextFunction } from 'express';
import * as shopService from '../services/shop.service';
import * as notifyService from '../services/notify.service';
import { ApiError } from '../utils/ApiError';

export async function listShops(req: Request, res: Response, next: NextFunction) {
  try {
    // If admin, return all shops; otherwise return student-facing list
    if (req.user?.userType === 'ADMIN') {
      const shops = await shopService.listAllShops();
      return res.json({ success: true, data: { shops } });
    }
    const onlyOpen = req.query.onlyOpen === 'true';
    const shops = await shopService.listShopsForStudents({ onlyOpen });
    res.json({ success: true, data: { shops } });
  } catch (error) { next(error); }
}

export async function getShop(req: Request, res: Response, next: NextFunction) {
  try {
    const shop = await shopService.getShopById(req.params.shopId as string);
    res.json({ success: true, data: { shop } });
  } catch (error) { next(error); }
}

export async function updateShopSettings(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    
    const { pricing, payoutMethods, ...restBody } = req.body;
    const updateData = {
      ...restBody,
      ...(pricing ? { bwPerPage: pricing.bwPerPage, colorPerPage: pricing.colorPerPage } : {}),
      ...(payoutMethods !== undefined ? { payoutMethods } : {})
    };

    const shop = await shopService.updateShopSettings(
      req.params.shopId as string,
      req.user.userId,
      updateData,
      req.user.userType === 'ADMIN'
    );
    res.json({ success: true, data: { shop } });
  } catch (error) { next(error); }
}

export async function approveShop(req: Request, res: Response, next: NextFunction) {
  try {
    const { approved, rejectionReason } = req.body;

    if (approved === false) {
      // `rejectionReason` was destructured away here, so `rejectShop`'s reason
      // parameter never received the admin's words and every rejected owner
      // read the same generic sentence. It is the only thing in this response
      // that tells them what to fix.
      const shop = await shopService.rejectShop(req.params.shopId as string, rejectionReason);
      notifyService.notifyShopDecision({
        shopId: shop.id,
        ownerUserId: shop.ownerUserId,
        shopName: shop.name,
        approved: false,
        reason: shop.rejectionReason,
      });
      return res.json({ success: true, message: 'Shop rejected', data: { shop } });
    }

    const shop = await shopService.approveShop(req.params.shopId as string);
    notifyService.notifyShopDecision({
      shopId: shop.id,
      ownerUserId: shop.ownerUserId,
      shopName: shop.name,
      approved: true,
    });
    res.json({ success: true, message: 'Shop approved', data: { shop } });
  } catch (error) { next(error); }
}

export async function archiveShop(req: Request, res: Response, next: NextFunction) {
  try {
    const { archived } = req.body;
    const shop = archived === false
      ? await shopService.unarchiveShop(req.params.shopId as string)
      : await shopService.archiveShop(req.params.shopId as string);
    res.json({ success: true, message: `Shop ${archived === false ? 'unarchived' : 'archived'}`, data: { shop } });
  } catch (error) { next(error); }
}

export async function getAggregate(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const aggregate = await shopService.getShopAggregate(
      req.params.shopId as string,
      req.user.userId,
      req.user.userType === 'ADMIN'
    );
    res.json({ success: true, data: { aggregate } });
  } catch (error) { next(error); }
}

export async function getBankDetails(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { prisma } = await import('../utils/prisma');
    const shopId = req.params.shopId as string;
    
    // Check ownership
    if (req.user.userType !== 'ADMIN') {
      const shop = await prisma.shop.findUnique({ where: { id: shopId } });
      if (!shop || shop.ownerUserId !== req.user.userId) {
        await prisma.bankAccessLog.create({ data: { shopId, userId: req.user.userId, userRole: req.user.userType as any, action: 'VIEW', ip: req.ip || '', success: false } });
        throw ApiError.forbidden('Not your shop');
      }
    }

    const bankDetails = await prisma.bankDetails.findUnique({ where: { shopId } });
    
    // Write access log
    await prisma.bankAccessLog.create({
      data: { shopId, targetId: bankDetails?.id, userId: req.user.userId, userRole: req.user.userType as any, action: 'VIEW', ip: req.ip || '', success: true }
    });

    if (bankDetails && req.user.userType !== 'ADMIN') {
      // Mask account number for non-admins (expose only last 4)
      const acct = bankDetails.accountNumber;
      if (acct && acct.length > 4) {
        bankDetails.accountNumber = '*'.repeat(acct.length - 4) + acct.slice(-4);
      }
    }

    res.json({ success: true, data: bankDetails });
  } catch (error) { next(error); }
}

export async function saveBankDetails(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { prisma } = await import('../utils/prisma');
    const shopId = req.params.shopId as string;
    
    // Check ownership
    if (req.user.userType !== 'ADMIN') {
      const shop = await prisma.shop.findUnique({ where: { id: shopId } });
      if (!shop || shop.ownerUserId !== req.user.userId) {
        await prisma.bankAccessLog.create({ data: { shopId, userId: req.user.userId, userRole: req.user.userType as any, action: 'EDIT', ip: req.ip || '', success: false } });
        throw ApiError.forbidden('Not your shop');
      }
    }

    const { accountNumber, ifscCode, accountHolderName, accountType, upiId } = req.body;
    
    // Validate inputs
    if (!accountNumber || !ifscCode || !accountHolderName || !accountType) {
      await prisma.bankAccessLog.create({ data: { shopId, userId: req.user.userId, userRole: req.user.userType as any, action: 'EDIT', ip: req.ip || '', success: false } });
      throw ApiError.badRequest('Missing required bank details');
    }

    const bankDetails = await prisma.bankDetails.upsert({
      where: { shopId },
      create: { 
        shopId, accountNumber, ifscCode, accountHolderName, 
        accountType: accountType as any, upiId, bankName: 'Unknown', 
        isVerified: false 
      },
      update: { 
        accountNumber, ifscCode, accountHolderName, 
        accountType: accountType as any, upiId, 
        isVerified: false, verifiedAt: null, verifiedBy: null 
      },
    });

    await prisma.bankAccessLog.create({
      data: { shopId, targetId: bankDetails.id, userId: req.user.userId, userRole: req.user.userType as any, action: 'EDIT', ip: req.ip || '', success: true }
    });

    res.json({ success: true, data: bankDetails });
  } catch (error) { next(error); }
}

export async function verifyBankDetails(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { prisma } = await import('../utils/prisma');
    const shopId = req.params.shopId as string;
    
    if (req.user.userType !== 'ADMIN') {
      await prisma.bankAccessLog.create({ data: { shopId, userId: req.user.userId, userRole: req.user.userType as any, action: 'VERIFY', ip: req.ip || '', success: false } });
      throw ApiError.forbidden('Only admins can verify bank details');
    }

    const bankDetails = await prisma.bankDetails.update({
      where: { shopId },
      data: { isVerified: true, verifiedAt: new Date(), verifiedBy: req.user.userId },
    });

    await prisma.bankAccessLog.create({
      data: { shopId, targetId: bankDetails.id, userId: req.user.userId, userRole: req.user.userType as any, action: 'VERIFY', ip: req.ip || '', success: true }
    });

    res.json({ success: true, data: bankDetails });
  } catch (error) { next(error); }
}

export async function getPaymentConfig(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { prisma } = await import('../utils/prisma');
    const shopId = req.params.shopId as string;
    
    // Check ownership
    if (req.user.userType !== 'ADMIN') {
      const shop = await prisma.shop.findUnique({ where: { id: shopId } });
      if (!shop || shop.ownerUserId !== req.user.userId) throw ApiError.forbidden('Not your shop');
    }

    const config = await prisma.payoutMethod.findMany({ where: { shopId } });
    res.json({ success: true, data: { payoutMethods: config } });
  } catch (error) { next(error); }
}
