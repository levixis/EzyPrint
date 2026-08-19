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
      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      }) as { body?: unknown };

      // Hand the handler the *parsed* body, not the raw one.
      //
      // The result used to be discarded — `parse` was called for its throw
      // alone. That made every schema's stripping and every transform
      // decorative: `.toLowerCase()` on an email never applied, and an
      // undeclared field passed straight through to the handler. Two
      // vulnerabilities came out of that second half. `createOrder` spreads
      // `...req.body`, so a caller could attach another student's file storage
      // key to their own order; `updateShopSettings` did the same, letting a
      // shop owner write `ledgerBalance`, `debtAmount` and `isApproved`
      // directly. Both are now also blocked by allowlists at their write sites
      // — defence in depth, because this line is easy to remove and the next
      // handler that spreads a body should not depend on remembering it.
      //
      // Validation errors still behave exactly as before; only the success
      // path changes.
      if (parsed && typeof parsed === 'object' && 'body' in parsed) {
        req.body = parsed.body;
      }

      // `query` and `params` are deliberately left alone. In Express 5
      // `req.query` is a getter with no setter, so assigning it throws — and
      // every handler already coerces its own query values by hand, so there
      // is nothing to gain and a crash to lose.

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
