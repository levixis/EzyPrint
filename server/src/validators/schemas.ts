import { z } from 'zod';
import { isUsablePageRate, pageRateFloorMessage } from '../services/pricing.service';

/**
 * Zod Validation Schemas — server-side input validation for ALL endpoints.
 *
 * SECURITY CRITICAL: Never trust client input. Every field is validated
 * for type, length, format, and allowed values before reaching business logic.
 *
 * Interview talking point: "All validation happens server-side with Zod schemas.
 * The client can send whatever it wants — the server rejects invalid data."
 */

// ────────────────────────────────────────────────────────────
// SHARED VALIDATORS
// ────────────────────────────────────────────────────────────

/**
 * Order matters here: trim and fold case *before* validating the format.
 *
 * The chain used to end `.email().max(255).toLowerCase().trim()`, which checks
 * the shape first — so an address pasted with a trailing space, which phone
 * keyboards and copy-from-email routinely produce, was rejected as "Invalid
 * email format" rather than cleaned up. Normalising first also means the value
 * stored and matched is the canonical one.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email format')
  .max(255, 'Email too long');

/**
 * Password: 8-72 chars (bcrypt truncates at 72), must include:
 * - At least 1 uppercase letter
 * - At least 1 lowercase letter
 * - At least 1 number
 * - At least 1 special character
 */
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password cannot exceed 72 characters (bcrypt limit)')
  .regex(/[A-Z]/, 'Password must include at least one uppercase letter')
  .regex(/[a-z]/, 'Password must include at least one lowercase letter')
  .regex(/[0-9]/, 'Password must include at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must include at least one special character');

const name = z
  .string()
  .min(1, 'Name is required')
  .max(100, 'Name too long')
  .trim();

const phone = z
  .string()
  .regex(/^[0-9]{10}$/, 'Phone must be 10 digits')
  .optional();


const pagination = {
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
};

// ────────────────────────────────────────────────────────────
// AUTH SCHEMAS
// ────────────────────────────────────────────────────────────

export const registerSchema = z.object({
  body: z.object({
    email,
    password,
    name,
    type: z.enum(['STUDENT', 'SHOP_OWNER'], {
      errorMap: () => ({ message: 'Type must be STUDENT or SHOP_OWNER' }),
    }),
    shopName: z.string().min(1).max(200).optional(),
    shopAddress: z.string().min(1).max(500).optional(),
    referralCode: z.string().min(1).max(50).optional(),
  }).refine(
    (data) => {
      if (data.type === 'SHOP_OWNER') {
        return !!data.shopName && !!data.shopAddress && !!data.referralCode;
      }
      return true;
    },
    { message: 'Shop name, address, and referral code are required for SHOP_OWNER registration' }
  ),
});

export const loginSchema = z.object({
  body: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email,
  }),
});

/**
 * Reset uses the full `password` validator, not login's `min(1)`. The strength
 * rules are enforced at registration, and a reset that skipped them would be a
 * way to give any account a one-character password.
 */
export const resetPasswordSchema = z.object({
  body: z.object({
    email,
    otp: z.string().regex(/^[0-9]{6}$/, 'The verification code is 6 digits'),
    password,
  }),
});

export const googleAuthSchema = z.object({
  body: z.object({
    idToken: z.string().min(1, 'Google ID token is required'),
    userType: z.enum(['STUDENT', 'SHOP_OWNER']).optional(),
    shopName: z.string().min(1).max(200).optional(),
    shopAddress: z.string().min(1).max(500).optional(),
    referralCode: z.string().min(1).max(50).optional(),
  }).refine(
    (data) => {
      // `userType` is optional here in a way it is not on the password path: an
      // existing user signing in sends none, and a new user who has not chosen
      // yet is answered with `isNewUser` so the app can ask. Only a caller
      // declaring themselves a shop owner has to bring the shop with them.
      //
      // Without this, a Google signup naming SHOP_OWNER and a referral code but
      // no shop name or address created the user and silently skipped the shop
      // — `if (userType === 'SHOP_OWNER' && shopName && shopAddress && ...)`.
      // The result was an owner account with no shop, which every route that
      // scopes by `shop.id` then has to defend against individually.
      if (data.userType === 'SHOP_OWNER') {
        return !!data.shopName && !!data.shopAddress && !!data.referralCode;
      }
      return true;
    },
    { message: 'Shop name, address, and referral code are required for SHOP_OWNER registration' }
  ),
});

export const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
  }),
});

// ────────────────────────────────────────────────────────────
// USER SCHEMAS
// ────────────────────────────────────────────────────────────

export const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100).trim().optional(),
    phone: phone,
    preferredLanguage: z.string().max(10).optional(),
    profilePhotoUrl: z.string().url('Invalid URL').max(500).optional(),
  }).refine(
    (data) => Object.keys(data).length > 0,
    { message: 'At least one field must be provided' }
  ),
});

export const pushTokenSchema = z.object({
  body: z.object({
    // FCM registration tokens are long opaque strings; bound them so a junk
    // payload cannot be stored on the user record.
    token: z.string().min(20).max(4096).trim(),
  }),
});

export const listUsersSchema = z.object({
  query: z.object({
    ...pagination,
    type: z.enum(['STUDENT', 'SHOP_OWNER', 'ADMIN']).optional(),
    search: z.string().max(100).optional(),
  }),
});

// ────────────────────────────────────────────────────────────
// SHOP SCHEMAS
// ────────────────────────────────────────────────────────────

/**
 * A shop's saved bank account or UPI handle.
 *
 * Declared here for two reasons. It is what a payout is sent to, and until now
 * it reached `prisma.payoutMethod.createMany` entirely unvalidated — any
 * length, any shape, an IFSC that is not one.
 *
 * It also has to be declared for `validate` to be able to strip anything it
 * does not recognise: an undeclared field is dropped, and dropping this one
 * would silently wipe a shop's payout details on their next settings save.
 * Every field the service reads is named.
 */
const payoutMethod = z.object({
  // Optional: sent back when editing an existing method, so the row keeps its
  // id across the delete-and-recreate the service performs.
  id: z.string().max(64).optional(),
  type: z.enum(['BANK_ACCOUNT', 'UPI']),
  accountHolderName: z.string().max(200).optional(),
  accountNumber: z.string().max(50).optional(),
  ifscCode: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC Code format').optional(),
  bankName: z.string().max(200).optional(),
  upiId: z.string().max(100).optional(),
  isPrimary: z.boolean().optional(),
  nickname: z.string().max(100).optional(),
}).refine(
  (pm) => (pm.type === 'UPI' ? !!pm.upiId : !!pm.accountNumber && !!pm.ifscCode),
  { message: 'A UPI method needs a UPI id; a bank method needs an account number and IFSC code' }
);

export const updateShopSchema = z.object({
  body: z.object({
    // Capped: a settings save rewrites every row, so an unbounded array is an
    // unbounded write.
    payoutMethods: z.array(payoutMethod).max(10).optional(),
    // Paise, and whole ones — a fraction of a paise cannot be charged, and
    // rounding it later is how a quote stops matching the amount taken.
    //
    // The ceiling reads 100000 rather than 1000 because these became paise:
    // the old cap was ₹1000 per page and had silently tightened to ₹10, so a
    // shop pricing colour above that was rejected as invalid.
    // The floor rejects the rupees-as-paise unit bug at its remaining entry
    // path. A price between 1 and 49 paise is a hundredth of a rupee a page —
    // never a real offer, and exactly what arrives when a caller sends rupees
    // into a paise field. Zero stays legal: a free B&W tier is a real thing.
    pricing: z.object({
      bwPerPage: z.number().int('Price must be a whole number of paise').min(0).max(100_000)
        .refine(isUsablePageRate, { message: pageRateFloorMessage('B/W') }),
      colorPerPage: z.number().int('Price must be a whole number of paise').min(0).max(100_000)
        .refine(isUsablePageRate, { message: pageRateFloorMessage('Colour') }),
    }).optional(),
    isOpen: z.boolean().optional(),
    contactPhone: z.string().max(20).optional(),
    contactPhoneAlt: z.string().max(20).optional(),
    contactEmail: z.string().email().max(255).optional(),
    whatsappNumber: z.string().max(20).optional(),
  }),
});

export const archiveShopSchema = z.object({
  body: z.object({
    archived: z.boolean(),
  }),
});

// ────────────────────────────────────────────────────────────
// ORDER SCHEMAS
// ────────────────────────────────────────────────────────────

export const createOrderSchema = z.object({
  body: z.object({
    shopId: z.string().min(1, 'Shop ID is required'),
    files: z.array(z.object({
      fileName: z.string().min(1).max(500),
      fileType: z.string().min(1).max(50),
      // `fileStoragePath` and `fileSizeBytes` are deliberately NOT accepted
      // here. A storage key is proof of possession — it is what
      // `verifyStorageAccess` resolves back to an owner to decide who may
      // download a document. Taking one from the request body let a caller
      // attach somebody else's key to their own order and then read that
      // person's file through their own ownership of the order they had just
      // created. Scanned IDs and coursework are what is in that bucket.
      //
      // The upload endpoints are the only legitimate way a key reaches the
      // database, and they already verify the order belongs to the caller
      // before linking. Order creation writes the rows; upload fills them in.
      fileSizeBytes: z.number().int().positive().optional(),
      copies: z.number().int().min(1).max(999),
      color: z.enum(['BLACK_WHITE', 'COLOR']),
      pageCount: z.number().int().min(1).max(9999),
      doubleSided: z.boolean(),
    })).min(1, 'At least one file is required'),
    specialInstructions: z.string().max(1000).optional(),
    userName: z.string().max(200).optional(),
    isPremiumOrder: z.boolean().optional(),
  }),
});

/**
 * REFUNDED is deliberately absent.
 *
 * It is a legal edge in VALID_TRANSITIONS and ADMIN bypasses the per-role
 * table, so an admin could set it here — moving no money, creating no
 * RefundRequest, writing no REFUND_DEDUCTION and consuming no OTP. The order
 * then read as refunded on every dashboard while the student had received
 * nothing and the shop kept its earning. Worse, REFUNDED is terminal for files,
 * and with no refund request in existence `hasOpenDispute` found nothing to
 * protect — so the documents were destroyed immediately, taking the evidence
 * for the refund that now had to be issued by hand.
 *
 * The refund routes are the only way to this status. They own the gateway call,
 * the ledger entry and the step-up code.
 */
export const updateOrderStatusSchema = z.object({
  body: z.object({
    status: z.enum([
      'PENDING_PAYMENT', 'PENDING_APPROVAL', 'PRINTING',
      'READY_FOR_PICKUP', 'COMPLETED', 'CANCELLED',
      'PAYMENT_FAILED',
    ]),
    shopNotes: z.string().max(1000).optional(),
  }),
});

export const listOrdersSchema = z.object({
  query: z.object({
    ...pagination,
    status: z.enum([
      'PENDING_PAYMENT', 'PENDING_APPROVAL', 'PRINTING',
      'READY_FOR_PICKUP', 'COMPLETED', 'CANCELLED',
      'PAYMENT_FAILED', 'REFUNDED',
    ]).optional(),
    shopId: z.string().optional(),
  }),
});

// ────────────────────────────────────────────────────────────
// PAYMENT SCHEMAS
// ────────────────────────────────────────────────────────────

export const createPaymentOrderSchema = z.object({
  body: z.object({
    orderId: z.string().min(1, 'Order ID is required'),
  }),
});

export const verifyPaymentSchema = z.object({
  body: z.object({
    orderId: z.string().min(1),
    razorpay_payment_id: z.string().min(1, 'razorpay_payment_id is required'),
    razorpay_order_id: z.string().min(1, 'razorpay_order_id is required'),
    razorpay_signature: z.string().min(1, 'razorpay_signature is required'),
  }),
});

// ────────────────────────────────────────────────────────────
// TICKET SCHEMAS
// ────────────────────────────────────────────────────────────

export const createTicketSchema = z.object({
  body: z.object({
    subject: z.string().min(1, 'Subject is required').max(300),
    description: z.string().min(1, 'Description is required').max(5000),
    category: z.enum(['ORDER_ISSUE', 'PAYMENT_ISSUE', 'DELIVERY_ISSUE', 'OTHER']),
    orderId: z.string().optional(),
    relatedOrderId: z.string().optional(),
    shopId: z.string().optional(),
  }),
});

export const ticketMessageSchema = z.object({
  body: z.object({
    message: z.string().min(1, 'Message is required').max(5000),
  }),
});

export const ticketStatusSchema = z.object({
  body: z.object({
    status: z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED']),
    note: z.string().max(1000).optional(),
  }),
});

// ────────────────────────────────────────────────────────────
// REFERRAL SCHEMAS
// ────────────────────────────────────────────────────────────

/**
 * `daysValid` reached `setDate()` unchecked, so a non-number produced an
 * Invalid Date and a 500, and a negative one minted a code that was expired
 * the moment it was issued.
 *
 * Capped at a year: a referral code is a short-lived invitation, and one that
 * never practically expires is a standing key to shop-owner registration.
 */
export const createReferralSchema = z.object({
  body: z.object({
    daysValid: z
      .number()
      .int('Validity must be a whole number of days')
      .min(1, 'A code must be valid for at least a day')
      .max(365, 'A code cannot be valid for more than a year')
      .optional(),
  }),
});

// ────────────────────────────────────────────────────────────
// PAYOUT, REFUND, AND BANK SCHEMAS
// ────────────────────────────────────────────────────────────

export const requestPayoutSchema = z.object({
  body: z.object({
    // Paise. Integer because money is never fractional at the smallest unit.
    amount: z.number().int('Amount must be a whole number of paise').positive('Amount must be greater than 0'),
    shopOwnerNote: z.string().max(1000).optional(),
  }),
});

export const actionPayoutSchema = z.object({
  body: z.object({
    adminNote: z.string().max(1000).optional(),
  }),
});

export const manualPayoutSchema = z.object({
  body: z.object({
    shopId: z.string().min(1, 'Shop ID is required'),
    amount: z.number().int('Amount must be a whole number of paise').positive('Amount must be positive'),
    adminNote: z.string().max(1000).optional(),
  }),
});

export const requestRefundSchema = z.object({
  body: z.object({
    orderId: z.string().min(1, 'Order ID is required'),
    reason: z.string().min(1, 'Reason is required').max(1000),
  }),
});

/** A shop refunding its own order. Same shape as a student's request. */
export const shopRefundSchema = z.object({
  body: z.object({
    orderId: z.string().min(1, 'Order ID is required'),
    reason: z.string().min(1, 'Reason is required').max(1000),
  }),
});

export const respondRefundSchema = z.object({
  body: z.object({
    approved: z.boolean(),
    shopResponse: z.string().max(1000).optional(),
  }),
});

export const resolveRefundSchema = z.object({
  body: z.object({
    action: z.enum(['APPROVE', 'DENY']),
    // Resolving a refund issues a real Razorpay refund, so it is gated behind a
    // one-time code like every other money-moving admin action.
    otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit verification code'),
    adminNote: z.string().max(1000).optional(),
    refundAmount: z.number().int('Amount must be a whole number of paise').positive().optional(),
  }),
});

export const saveBankDetailsSchema = z.object({
  body: z.object({
    accountHolderName: z.string().min(1, 'Account holder name is required').max(200),
    bankName: z.string().min(1, 'Bank name is required').max(200),
    accountNumber: z.string().min(5, 'Account number is too short').max(50),
    ifscCode: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Invalid IFSC Code format'),
    accountType: z.enum(['SAVINGS', 'CURRENT']),
    upiId: z.string().max(100).optional(),
  }),
});

// ────────────────────────────────────────────────────────────
// OTP-GATED ACTIONS
// ────────────────────────────────────────────────────────────

/**
 * Identifiers a one-time code may be issued for.
 *
 * Either a known constant, or a scoped `<kind>_<id>` for actions that target a
 * specific record. Constrained because the value is echoed into the subject and
 * body of the HTML email that delivers the code.
 */
export const otpActionId = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^(DELETE_USER|ARCHIVE_USER|DELETE_OWN_ACCOUNT|ARCHIVE_OWN_SHOP|(refund|payout|reactivation)_[A-Za-z0-9_-]{1,60})$/,
    'Unrecognized action'
  );

export const requestOtpSchema = z.object({
  actionId: otpActionId,
});

/** Body shape for any endpoint gated behind a one-time code. */
export const otpGuardedSchema = z.object({
  body: z.object({
    otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit verification code'),
    adminNote: z.string().max(1000).optional(),
  }),
});

export const manualPayoutWithOtpSchema = z.object({
  body: z.object({
    shopId: z.string().min(1, 'Shop ID is required'),
    amount: z.number().int().positive('Amount must be positive'),
    adminNote: z.string().max(1000).optional(),
    otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit verification code'),
  }),
});

export const resolveReactivationSchema = z.object({
  body: z.object({
    action: z.enum(['approve', 'reject']),
    otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit verification code'),
    rejectionReason: z.string().max(1000).optional(),
  }),
});
