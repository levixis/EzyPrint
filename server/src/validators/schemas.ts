import { z } from 'zod';

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

const email = z
  .string()
  .email('Invalid email format')
  .max(255, 'Email too long')
  .toLowerCase()
  .trim();

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

const cuid = z.string().min(20).max(30);

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
  }).refine(
    (data) => {
      if (data.type === 'SHOP_OWNER') {
        return !!data.shopName && !!data.shopAddress;
      }
      return true;
    },
    { message: 'Shop name and address are required for SHOP_OWNER registration' }
  ),
});

export const loginSchema = z.object({
  body: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),
});

export const googleAuthSchema = z.object({
  body: z.object({
    idToken: z.string().min(1, 'Google ID token is required'),
    userType: z.enum(['STUDENT', 'SHOP_OWNER']).optional().default('STUDENT'),
  }),
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

export const updateShopSchema = z.object({
  body: z.object({
    bwPerPage: z.number().min(0, 'Price cannot be negative').max(1000).optional(),
    colorPerPage: z.number().min(0, 'Price cannot be negative').max(1000).optional(),
    isOpen: z.boolean().optional(),
    contactPhone: z.string().max(20).optional(),
    contactPhoneAlt: z.string().max(20).optional(),
    contactEmail: z.string().email().max(255).optional(),
    whatsappNumber: z.string().max(20).optional(),
  }),
});

export const archiveShopSchema = z.object({
  body: z.object({
    action: z.enum(['archive', 'unarchive'], {
      errorMap: () => ({ message: "Action must be 'archive' or 'unarchive'" }),
    }),
  }),
});

// ────────────────────────────────────────────────────────────
// ORDER SCHEMAS
// ────────────────────────────────────────────────────────────

export const createOrderSchema = z.object({
  body: z.object({
    shopId: z.string().min(1, 'Shop ID is required'),
    fileName: z.string().min(1, 'File name is required').max(500),
    fileType: z.string().min(1).max(50),
    fileStoragePath: z.string().max(1000).optional(),
    fileSizeBytes: z.number().int().positive().optional(),
    copies: z.number().int().min(1, 'At least 1 copy').max(999, 'Max 999 copies'),
    color: z.enum(['BLACK_WHITE', 'COLOR']),
    pages: z.number().int().min(1, 'At least 1 page').max(9999, 'Max 9999 pages'),
    doubleSided: z.boolean(),
    startPage: z.number().int().positive().optional(),
    endPage: z.number().int().positive().optional(),
    specialInstructions: z.string().max(1000).optional(),
    userName: z.string().max(200).optional(),
    isPremiumOrder: z.boolean().optional(),
  }),
});

export const updateOrderStatusSchema = z.object({
  body: z.object({
    status: z.enum([
      'PENDING_PAYMENT', 'PENDING_APPROVAL', 'PRINTING',
      'READY_FOR_PICKUP', 'COMPLETED', 'CANCELLED',
      'PAYMENT_FAILED', 'REFUNDED',
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
    razorpayPaymentId: z.string().min(1, 'razorpayPaymentId is required'),
    razorpayOrderId: z.string().min(1, 'razorpayOrderId is required'),
    razorpaySignature: z.string().min(1, 'razorpaySignature is required'),
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
