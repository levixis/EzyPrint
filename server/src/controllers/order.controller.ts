import { Request, Response, NextFunction } from 'express';
import * as orderService from '../services/order.service';
import { ApiError } from '../utils/ApiError';

export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const order = await orderService.createOrder({
      ...req.body,
      userId: req.user.userId,
      userName: req.body.userName || req.user.email,
    });
    res.status(201).json({ success: true, message: 'Order created', data: { order } });
  } catch (error) { next(error); }
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { status, page, limit } = req.query;
    const options = {
      status: status as any,
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    };

    let result;
    if (req.user.userType === 'STUDENT') {
      result = await orderService.listOrdersForStudent(req.user.userId, options);
    } else if (req.user.userType === 'SHOP_OWNER') {
      result = await orderService.listOrdersForShop(req.user.userId, options);
    } else {
      throw ApiError.forbidden('Use /admin/all for admin order listing');
    }

    res.json({ success: true, data: result });
  } catch (error) { next(error); }
}

export async function getOrder(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const order = await orderService.getOrderById(
      req.params.orderId,
      req.user.userId,
      req.user.userType
    );
    res.json({ success: true, data: { order } });
  } catch (error) { next(error); }
}

export async function updateStatus(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw ApiError.unauthorized();
    const { status, shopNotes } = req.body;
    if (!status) throw ApiError.badRequest('Status is required');

    const order = await orderService.updateOrderStatus(
      req.params.orderId,
      status,
      req.user.userId,
      req.user.userType,
      shopNotes
    );
    res.json({ success: true, message: `Order status updated to ${status}`, data: { order } });
  } catch (error) { next(error); }
}

export async function listAllOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, shopId, page, limit } = req.query;
    const result = await orderService.listAllOrders({
      status: status as any,
      shopId: shopId as string,
      page: page ? parseInt(page as string, 10) : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });
    res.json({ success: true, data: result });
  } catch (error) { next(error); }
}
