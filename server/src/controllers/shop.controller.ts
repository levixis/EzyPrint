import { Request, Response, NextFunction } from 'express';
import * as shopService from '../services/shop.service';
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
    const shop = await shopService.updateShopSettings(
      req.params.shopId as string,
      req.user.userId,
      req.body
    );
    res.json({ success: true, data: { shop } });
  } catch (error) { next(error); }
}

export async function approveShop(req: Request, res: Response, next: NextFunction) {
  try {
    const shop = await shopService.approveShop(req.params.shopId as string);
    res.json({ success: true, message: 'Shop approved', data: { shop } });
  } catch (error) { next(error); }
}

export async function archiveShop(req: Request, res: Response, next: NextFunction) {
  try {
    const { action } = req.body; // 'archive' or 'unarchive'
    const shop = action === 'unarchive'
      ? await shopService.unarchiveShop(req.params.shopId as string)
      : await shopService.archiveShop(req.params.shopId as string);
    res.json({ success: true, message: `Shop ${action || 'archive'}d`, data: { shop } });
  } catch (error) { next(error); }
}

export async function getAggregate(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const aggregate = await shopService.getShopAggregate(req.params.shopId as string, req.user.userId);
    res.json({ success: true, data: { aggregate } });
  } catch (error) { next(error); }
}
