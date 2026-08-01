/**
 * Unit Tests — Zod Validation Schemas
 *
 * Tests that our validation layer correctly rejects malicious/invalid
 * input BEFORE it reaches business logic. This is the first line of defense.
 */

import {
  registerSchema,
  loginSchema,
  createOrderSchema,
  updateOrderStatusSchema,
  createTicketSchema,
  updateShopSchema,
  updateProfileSchema,
  verifyPaymentSchema,
} from '../../validators/schemas';

// Helper to validate and get errors
function validate(schema: any, data: any) {
  const result = schema.safeParse(data);
  return {
    success: result.success,
    errors: result.success ? [] : result.error.errors.map((e: any) => ({
      field: e.path.join('.'),
      message: e.message,
    })),
  };
}

// ────────────────────────────────────────────────────────────
// REGISTRATION VALIDATION
// ────────────────────────────────────────────────────────────

describe('Registration Schema', () => {
  const validData = {
    body: {
      email: 'test@example.com',
      password: 'Test1234!',
      name: 'Test User',
      type: 'STUDENT',
    },
  };

  test('accepts valid student registration', () => {
    expect(validate(registerSchema, validData).success).toBe(true);
  });

  test('rejects password shorter than 8 chars', () => {
    const result = validate(registerSchema, {
      body: { ...validData.body, password: 'Ab1!' },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('at least 8');
  });

  test('rejects password longer than 72 chars (bcrypt limit)', () => {
    const longPass = 'Aa1!' + 'x'.repeat(70);
    const result = validate(registerSchema, {
      body: { ...validData.body, password: longPass },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('72');
  });

  test('rejects password without uppercase', () => {
    const result = validate(registerSchema, {
      body: { ...validData.body, password: 'test1234!' },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('uppercase');
  });

  test('rejects password without lowercase', () => {
    const result = validate(registerSchema, {
      body: { ...validData.body, password: 'TEST1234!' },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('lowercase');
  });

  test('rejects password without number', () => {
    const result = validate(registerSchema, {
      body: { ...validData.body, password: 'TestTest!' },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('number');
  });

  test('rejects password without special character', () => {
    const result = validate(registerSchema, {
      body: { ...validData.body, password: 'TestTest1234' },
    });
    expect(result.success).toBe(false);
    expect(result.errors[0].message).toContain('special');
  });

  test('rejects invalid email format', () => {
    const result = validate(registerSchema, {
      body: { ...validData.body, email: 'not-an-email' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid user type', () => {
    const result = validate(registerSchema, {
      body: { ...validData.body, type: 'ADMIN' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects SHOP_OWNER without shopName', () => {
    const result = validate(registerSchema, {
      body: { ...validData.body, type: 'SHOP_OWNER' },
    });
    expect(result.success).toBe(false);
    expect(result.errors.some((e: any) => e.message.includes('shop') || e.message.includes('Shop'))).toBe(true);
  });

  test('rejects SHOP_OWNER without referralCode', () => {
    const result = validate(registerSchema, {
      body: { ...validData.body, type: 'SHOP_OWNER', shopName: 'Test Shop', shopAddress: '123 Campus Road' },
    });
    expect(result.success).toBe(false);
    expect(result.errors.some((e: any) => e.message.includes('referral') || e.message.includes('Referral'))).toBe(true);
  });

  test('accepts SHOP_OWNER with shopName, shopAddress, and referralCode', () => {
    const result = validate(registerSchema, {
      body: {
        ...validData.body,
        type: 'SHOP_OWNER',
        shopName: 'Test Shop',
        shopAddress: '123 Campus Road',
        referralCode: 'VALIDCODE',
      },
    });
    expect(result.success).toBe(true);
  });

  test('normalizes email to lowercase', () => {
    const result = registerSchema.parse({
      body: { ...validData.body, email: 'TEST@EXAMPLE.COM' },
    });
    expect(result.body.email).toBe('test@example.com');
  });
});

// ────────────────────────────────────────────────────────────
// ORDER VALIDATION
// ────────────────────────────────────────────────────────────

describe('Create Order Schema', () => {
  const validOrder = {
    body: {
      shopId: 'cms123456789abcdefg',
      files: [{
        fileName: 'thesis.pdf',
        fileType: 'PDF',
        copies: 3,
        color: 'COLOR',
        pageCount: 20,
        doubleSided: true,
      }],
    },
  };

  test('accepts valid order', () => {
    expect(validate(createOrderSchema, validOrder).success).toBe(true);
  });

  test('rejects zero copies', () => {
    const result = validate(createOrderSchema, {
      body: { ...validOrder.body, files: [{ ...validOrder.body.files[0], copies: 0 }] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects negative pages', () => {
    const result = validate(createOrderSchema, {
      body: { ...validOrder.body, files: [{ ...validOrder.body.files[0], pageCount: -5 }] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects copies over 999', () => {
    const result = validate(createOrderSchema, {
      body: { ...validOrder.body, files: [{ ...validOrder.body.files[0], copies: 1000 }] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects invalid color value', () => {
    const result = validate(createOrderSchema, {
      body: { ...validOrder.body, files: [{ ...validOrder.body.files[0], color: 'RED' }] },
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing required fields', () => {
    const result = validate(createOrderSchema, {
      body: { shopId: 'x' },
    });
    expect(result.success).toBe(false);
  });
});

describe('Order Status Schema', () => {
  test('accepts valid status', () => {
    expect(validate(updateOrderStatusSchema, {
      body: { status: 'PRINTING' },
    }).success).toBe(true);
  });

  test('rejects invalid status', () => {
    expect(validate(updateOrderStatusSchema, {
      body: { status: 'FLYING' },
    }).success).toBe(false);
  });

  test('accepts shopNotes with status', () => {
    expect(validate(updateOrderStatusSchema, {
      body: { status: 'PRINTING', shopNotes: 'Starting print' },
    }).success).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// TICKET VALIDATION
// ────────────────────────────────────────────────────────────

describe('Ticket Schema', () => {
  test('accepts valid ticket', () => {
    expect(validate(createTicketSchema, {
      body: {
        subject: 'Issue with order',
        description: 'My order was not printed',
        category: 'ORDER_ISSUE',
      },
    }).success).toBe(true);
  });

  test('rejects invalid category', () => {
    expect(validate(createTicketSchema, {
      body: {
        subject: 'Issue',
        description: 'Details',
        category: 'FOOD_ISSUE',
      },
    }).success).toBe(false);
  });

  test('rejects description over 5000 chars', () => {
    expect(validate(createTicketSchema, {
      body: {
        subject: 'Issue',
        description: 'x'.repeat(5001),
        category: 'OTHER',
      },
    }).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// SHOP VALIDATION
// ────────────────────────────────────────────────────────────

describe('Shop Update Schema', () => {
  test('accepts valid pricing update', () => {
    expect(validate(updateShopSchema, {
      body: { pricing: { bwPerPage: 2, colorPerPage: 5 } },
    }).success).toBe(true);
  });

  test('rejects negative pricing', () => {
    expect(validate(updateShopSchema, {
      body: { pricing: { bwPerPage: -1, colorPerPage: 5 } },
    }).success).toBe(false);
  });

  test('rejects pricing above max (₹1000 a page, in paise)', () => {
    // This used to assert 1001 was rejected, which was correct while these
    // were rupees. After the paise migration the same number meant ₹10.01 and
    // the assertion was pinning the ceiling 100x too low — the test was
    // holding the bug in place.
    expect(validate(updateShopSchema, {
      body: { pricing: { bwPerPage: 200, colorPerPage: 1001 } },
    }).success).toBe(true);

    expect(validate(updateShopSchema, {
      body: { pricing: { bwPerPage: 200, colorPerPage: 100_001 } },
    }).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// PROFILE VALIDATION
// ────────────────────────────────────────────────────────────

describe('Profile Update Schema', () => {
  test('accepts valid phone', () => {
    expect(validate(updateProfileSchema, {
      body: { phone: '9876543210' },
    }).success).toBe(true);
  });

  test('rejects non-10-digit phone', () => {
    expect(validate(updateProfileSchema, {
      body: { phone: '123' },
    }).success).toBe(false);
  });

  test('rejects empty body', () => {
    expect(validate(updateProfileSchema, {
      body: {},
    }).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// PAYMENT VALIDATION
// ────────────────────────────────────────────────────────────

describe('Payment Verify Schema', () => {
  test('accepts all required fields', () => {
    expect(validate(verifyPaymentSchema, {
      body: {
        orderId: 'ord_123',
        razorpay_payment_id: 'pay_xxx',
        razorpay_order_id: 'order_xxx',
        razorpay_signature: 'sig_xxx',
      },
    }).success).toBe(true);
  });

  test('rejects missing razorpaySignature', () => {
    expect(validate(verifyPaymentSchema, {
      body: {
        orderId: 'ord_123',
        razorpay_payment_id: 'pay_xxx',
        razorpay_order_id: 'order_xxx',
      },
    }).success).toBe(false);
  });
});

/**
 * `daysValid` reached `setDate()` straight from the request body. A string
 * produced an Invalid Date and a 500; a negative number minted a code that had
 * already expired when it was handed out.
 */
describe('createReferralSchema', () => {
  const { createReferralSchema } = require('../../validators/schemas');
  const parse = (daysValid: unknown) =>
    createReferralSchema.safeParse({ body: { daysValid }, query: {}, params: {} });

  test('accepts a sane validity window', () => {
    expect(parse(7).success).toBe(true);
  });

  test('omitting it is fine — the service defaults to 7 days', () => {
    expect(createReferralSchema.safeParse({ body: {}, query: {}, params: {} }).success).toBe(true);
  });

  test('rejects a non-number before it can become an Invalid Date', () => {
    expect(parse('abc').success).toBe(false);
  });

  test('rejects zero and negative windows', () => {
    expect(parse(0).success).toBe(false);
    expect(parse(-100).success).toBe(false);
  });

  test('rejects a fractional day', () => {
    expect(parse(1.5).success).toBe(false);
  });

  test('caps validity at a year, so no code is a standing key', () => {
    expect(parse(365).success).toBe(true);
    expect(parse(4000).success).toBe(false);
  });
});

/**
 * Shop pricing is paise. The bounds were written when it was rupees, so the
 * ceiling had quietly become ₹10 per page — a shop charging more for colour
 * was told its price was invalid.
 */
describe('updateShopSchema pricing', () => {
  const { updateShopSchema } = require('../../validators/schemas');
  const parse = (bwPerPage: unknown, colorPerPage: unknown) =>
    updateShopSchema.safeParse({ body: { pricing: { bwPerPage, colorPerPage } }, query: {}, params: {} });

  test('accepts ordinary campus rates in paise', () => {
    // ₹2 and ₹5 a page.
    expect(parse(200, 500).success).toBe(true);
  });

  test('accepts a price the old rupee-era cap would have rejected', () => {
    // ₹15 a page in paise. Under max(1000) this was refused as invalid.
    expect(parse(1500, 2000).success).toBe(true);
  });

  test('free is allowed, negative is not', () => {
    expect(parse(0, 300).success).toBe(true);
    expect(parse(-1, 300).success).toBe(false);
  });

  test('rejects a fraction of a paise', () => {
    // Rounding this later is how a quote stops matching the amount charged.
    expect(parse(150.5, 300).success).toBe(false);
  });

  test('still refuses an absurd price', () => {
    // ₹1000 a page is the ceiling; beyond it is a typo, not a rate.
    expect(parse(100_000, 300).success).toBe(true);
    expect(parse(100_001, 300).success).toBe(false);
  });
});
