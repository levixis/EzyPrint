import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ApiError } from '../utils/ApiError';

/**
 * Request validation middleware using Zod schemas.
 *
 * Validates req.body, req.query, and/or req.params against provided schemas.
 * On failure, returns a 400 with structured error details.
 *
 * Usage:
 *   import { z } from 'zod';
 *
 *   const createOrderSchema = z.object({
 *     body: z.object({
 *       shopId: z.string().cuid(),
 *       fileName: z.string().min(1),
 *       pages: z.number().int().positive(),
 *     }),
 *   });
 *
 *   router.post('/orders', validate(createOrderSchema), controller.createOrder);
 */
export const validate = (schema: ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errorMessages = error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));

        res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errorMessages,
        });
        return;
      }
      next(ApiError.internal('Validation error'));
    }
  };
};
