/**
 * lib/queries.ts — All REST API endpoint functions grouped by domain.
 *
 * Replaces:
 * - Firestore getDoc/getDocs/setDoc/updateDoc/addDoc/onSnapshot
 * - Firebase Storage upload/download/delete
 * - Cloud Functions httpsCallable
 *
 * Every function returns typed data using the API client from lib/api.ts.
 */

import * as api from './api';
import {
  parseResponse,
  parseListResponse,
  supportTicketSchema,
  orderSchema,
  payoutSchema,
  refundRequestSchema,
  ledgerEntrySchema,
  notificationSchema,
  userSchema,
  referralCodeSchema,
  reactivationRequestSchema,
} from './schemas';
import type {
  User, ShopProfile, DocumentOrder, NotificationMessage,
  SupportTicket, ShopPayout, ShopPricing, PayoutMethod,
  OrderStatus, TicketCategory, TicketStatus, PrintColor,
  ReactivationRequest, RefundRequest,
  ShopLedgerEntry, ShopAggregate, BankDetails, PaymentConfiguration,
} from '../types';

// ──────────────────────────────────────────────
// AUTH
// ──────────────────────────────────────────────

export interface AuthTokens {
  user: User;
  tokens: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresIn?: string;
  };
}

export const authApi = {
  register: (data: {
    email: string; password: string; name: string;
    type: 'STUDENT' | 'SHOP_OWNER';
    shopName?: string; shopAddress?: string; referralCode?: string;
  }) => api.post<AuthTokens>('/auth/register', data),

  login: (email: string, password: string) =>
    api.post<AuthTokens>('/auth/login', { email, password }),

  googleAuth: (data: { idToken: string; userType?: 'STUDENT' | 'SHOP_OWNER'; shopName?: string; shopAddress?: string; referralCode?: string; }) =>
    api.post<AuthTokens | { isNewUser: true; email: string; name: string }>('/auth/google', data),

  /**
   * Ask for a reset code. Succeeds whether or not the address has an account —
   * the server answers identically on purpose, so never present the result as
   * confirmation that the email is registered.
   */
  forgotPassword: (email: string) =>
    api.post<{ message: string }>('/auth/forgot-password', { email }),

  /** Set a new password with the emailed code. Signs the account out everywhere. */
  resetPassword: (email: string, otp: string, password: string) =>
    api.post<{ message: string }>('/auth/reset-password', { email, otp, password }),

  refresh: (refreshToken: string) =>
    api.post<{ tokens: { accessToken: string; refreshToken: string } }>('/auth/refresh', { refreshToken }),

  me: () => api.get<{ user: User }>('/auth/me').then(r => r.user),

  logout: () => api.post('/auth/logout'),

  logoutAll: () => api.post('/auth/logout-all'),
};

// ──────────────────────────────────────────────
// USERS
// ──────────────────────────────────────────────

export const userApi = {
  getProfile: () => api.get<User>('/users/me'),

  updateProfile: (data: Partial<Pick<User, 'name' | 'phone' | 'preferredLanguage' | 'profilePhotoUrl'>>) =>
    api.patch<User>('/users/me', data),

  listUsers: (params?: { type?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.type) query.set('type', params.type);
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return api.get<{ users: unknown; pagination: any }>(`/users${qs ? `?${qs}` : ''}`)
      .then(r => parseListResponse(userSchema, r.users, 'usersApi.list') as unknown as User[]);
  },
};

// ──────────────────────────────────────────────
// SHOPS
// ──────────────────────────────────────────────

const mapShopProfile = (shop: any): ShopProfile => {
  if (!shop) return shop;
  // Handle backend sending flat bwPerPage/colorPerPage vs nested customPricing
  if (shop.bwPerPage !== undefined && shop.colorPerPage !== undefined && !shop.customPricing) {
    return {
      ...shop,
      customPricing: {
        bwPerPage: shop.bwPerPage,
        colorPerPage: shop.colorPerPage,
      },
    };
  }
  return shop;
};

export const shopApi = {
  list: (params?: { approved?: boolean; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.approved !== undefined) query.set('approved', String(params.approved));
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return api.get<{ shops: any[] }>(`/shops${qs ? `?${qs}` : ''}`).then(r => (r.shops || []).map(mapShopProfile));
  },

  getById: (shopId: string) =>
    api.get<{ shop: any }>(`/shops/${shopId}`).then(r => mapShopProfile(r.shop)),

  update: (shopId: string, data: {
    pricing?: ShopPricing;
    isOpen?: boolean;
    payoutMethods?: PayoutMethod[];
    contactPhone?: string;
    contactPhoneAlt?: string;
    contactEmail?: string;
    whatsappNumber?: string;
  }) => api.patch<{ shop: any }>(`/shops/${shopId}`, data).then(r => mapShopProfile(r.shop)),

  approve: (shopId: string) =>
    api.patch(`/shops/${shopId}/approve`, { approved: true }),

  reject: (shopId: string, rejectionReason?: string) =>
    api.patch(`/shops/${shopId}/approve`, { approved: false, rejectionReason }),

  archive: (shopId: string) =>
    api.patch(`/shops/${shopId}/archive`, { archived: true }),

  unarchive: (shopId: string) =>
    api.patch(`/shops/${shopId}/archive`, { archived: false }),

  getAggregate: (shopId: string) =>
    api.get<{ aggregate: ShopAggregate }>(`/shops/${shopId}/aggregate`).then(r => r.aggregate),
};

// ──────────────────────────────────────────────
// ORDERS
// ──────────────────────────────────────────────

export const orderApi = {
  create: (data: {
    shopId: string;
    specialInstructions?: string;
    files: {
      fileName: string; fileType: string; fileSizeBytes: number;
      pageCount: number; color: PrintColor; copies: number; doubleSided: boolean;
    }[];
  }) => api.post<{ orderId: string; verifiedPrice: DocumentOrder['priceDetails']; files: { id: string }[] }>('/orders', data),

  list: (params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return api.get<{ orders: unknown }>(`/orders${qs ? `?${qs}` : ''}`)
      .then(r => parseListResponse(orderSchema, r.orders, 'orderApi.list') as unknown as DocumentOrder[]);
  },

  listAll: (params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    // Guarded like `list` above — same collection, same components rendering
    // it. Only the student/shop endpoint was checked, so the admin view of the
    // very same orders had no protection at all.
    return api.get<{ orders: unknown }>(`/orders/admin/all${qs ? `?${qs}` : ''}`)
      .then(r => parseListResponse(orderSchema, r.orders, 'orderApi.listAll') as unknown as DocumentOrder[]);
  },

  getById: (orderId: string) =>
    api.get<{ order: unknown }>(`/orders/${orderId}`)
      .then(r => parseResponse(orderSchema, r.order, 'orderApi.getById') as unknown as DocumentOrder),

  updateStatus: (orderId: string, status: OrderStatus, details?: {
    shopNotes?: string; paymentAttemptedAt?: string;
  }) => api.patch<DocumentOrder>(`/orders/${orderId}/status`, { status, ...details }),

  requestRefund: (orderId: string, reason: string) =>
    refundApi.create(orderId, reason),
};

// ──────────────────────────────────────────────
// PAYMENTS
// ──────────────────────────────────────────────

export const paymentApi = {
  /**
   * Set up a payment for an order — or report that it was already paid.
   *
   * `paid` comes back when a retry turned out to be unnecessary: the earlier
   * attempt had actually been captured at the gateway and the server has just
   * adopted it. The caller must show `message` and open no checkout, otherwise
   * the student is charged a second time for the order they already paid for.
   */
  createOrder: (orderId: string) =>
    api.post<{
      razorpayOrderId: string;
      amount: number;
      currency: string;
      key: string;
      paid?: boolean;
      recovered?: boolean;
      message?: string;
    }>('/payments/create-order', { orderId }),

  verify: (data: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
    orderId: string;
  }) => api.post<{ verified: boolean }>('/payments/verify', data),

  /** Student Pass has no local order row, so it uses its own pair of endpoints. */
  createPassOrder: () =>
    api.post<{ razorpayOrderId: string; amount: number; currency: string; key: string }>(
      '/payments/pass/create-order'
    ),

  verifyPass: (data: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => api.post<{ hasStudentPass: boolean; studentPassActivatedAt: string | null }>(
    '/payments/pass/verify', data
  ),

  reconcile: () =>
    api.post<{ reconciled: number }>('/payments/reconcile'),
};

// ──────────────────────────────────────────────
// UPLOADS (File Storage — replaces Firebase Storage)
// ──────────────────────────────────────────────

export const uploadApi = {
  /**
   * Upload a single file.
   *
   * `uploadId` is the server's idempotency key — it carries a unique constraint,
   * so re-sending the same id returns the existing file rather than storing a
   * second copy. The server rejects a request without one, which is why the
   * caller must keep the same id across retries instead of letting this
   * generate a fresh one each time.
   */
  uploadSingle: (file: File, uploadId: string, metadata?: Record<string, string>) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('uploadId', uploadId);
    if (metadata) {
      formData.append('metadata', JSON.stringify(metadata));
    }
    return api.upload<{ storageKey: string; url: string }>('/uploads/single', formData);
  },

  /** Upload multiple files */
  uploadMultiple: (files: File[], metadata?: Record<string, string>) => {
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));
    if (metadata) {
      formData.append('metadata', JSON.stringify(metadata));
    }
    return api.upload<{ storageKeys: string[]; urls: string[] }>('/uploads/multiple', formData);
  },

  /** Get a presigned download URL */
  getDownloadUrl: (storageKey: string) =>
    api.get<{ url: string }>(`/uploads/url/${encodeURIComponent(storageKey)}`),

  /** Download a file as Blob */
  downloadFile: (storageKey: string) =>
    api.downloadBlob(`/uploads/download/${encodeURIComponent(storageKey)}`),

  /** Delete a file */
  deleteFile: (storageKey: string) =>
    api.del(`/uploads/${encodeURIComponent(storageKey)}`),
};

// ──────────────────────────────────────────────
// NOTIFICATIONS
// ──────────────────────────────────────────────

export const notificationApi = {
  list: (params?: { limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return api
      .get<{ notifications: unknown }>(`/notifications${qs ? `?${qs}` : ''}`)
      .then(r => parseListResponse(
        notificationSchema,
        r.notifications,
        'notificationApi.list'
      ) as unknown as NotificationMessage[]);
  },

  markAsRead: (notificationId: string) =>
    api.patch(`/notifications/${notificationId}/read`),

  markAllAsRead: () =>
    api.patch('/notifications/read-all'),
};

// ──────────────────────────────────────────────
// TICKETS
// ──────────────────────────────────────────────

export const ticketApi = {
  create: (data: {
    subject: string;
    category: TicketCategory;
    description: string;
    relatedOrderId?: string;
  }) => api.post<{ ticket: { id: string } }>('/tickets', data).then(r => ({ ticketId: r.ticket.id })),

  list: () => api.get<{ tickets: unknown }>('/tickets')
    .then(r => parseListResponse(supportTicketSchema, r.tickets, 'ticketApi.list') as unknown as SupportTicket[]),

  /**
   * The detail view — and the screen the second blank page came from.
   *
   * `list` was guarded after `messages` blanked the ticket list; opening a
   * ticket then blanked on `statusHistory`, because the guard went on the list
   * and this returns a ticket too. Every collection on the schema is defaulted,
   * so a missing one renders as empty here as well.
   */
  getById: (ticketId: string) =>
    api.get<{ ticket: unknown }>(`/tickets/${ticketId}`)
      .then(r => parseResponse(supportTicketSchema, r.ticket, 'ticketApi.getById') as unknown as SupportTicket),

  addMessage: (ticketId: string, message: string) =>
    api.post<{ message: { id: string } }>(`/tickets/${ticketId}/messages`, { message }),

  updateStatus: (ticketId: string, status: TicketStatus, note?: string) =>
    api.patch(`/tickets/${ticketId}/status`, { status, note }),
};

// ──────────────────────────────────────────────
// PAYOUTS (Ledger-based)
// ──────────────────────────────────────────────

export const payoutApi = {
  getBalance: (shopId: string) =>
    api.get<{ pendingBalance: number; ledgerBalance: number; debtAmount: number }>(
      `/payouts/balance/${shopId}`
    ),

  getLedger: (shopId: string, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    const qs = query.toString();
    return api
      .get<{ entries: unknown; pagination: any; currentBalance: number; ledgerBalance: number }>(
        `/payouts/ledger/${shopId}${qs ? `?${qs}` : ''}`
      )
      .then(r => ({
        ...r,
        // The shop dashboard sorts, filters and reduces over this to produce
        // "Today's Earnings" and the activity list. It was an unchecked `as`,
        // so an endpoint that answered without `entries` spread `undefined` and
        // blanked the screen that shows a shop its money — the worst possible
        // one to lose, because a blank money page is indistinguishable from
        // having none.
        entries: parseListResponse(
          ledgerEntrySchema,
          r.entries,
          'payoutApi.getLedger'
        ) as unknown as ShopLedgerEntry[],
      }));
  },

  request: (data: { shopId: string; amount: number; shopOwnerNote?: string }) =>
    api.post<ShopPayout>('/payouts/request', data),

  /** Approve and initiate the transfer. Moves the payout to IN_TRANSIT. */
  approve: (payoutId: string, otp: string, adminNote?: string) =>
    api.post(`/payouts/${payoutId}/approve`, { otp, adminNote }),

  /** Confirm an in-transit payout has landed in the shop's bank account. */
  markPaid: (payoutId: string, otp: string, adminNote?: string) =>
    api.post(`/payouts/${payoutId}/mark-paid`, { otp, adminNote }),

  reject: (payoutId: string, otp: string, adminNote?: string) =>
    api.post(`/payouts/${payoutId}/reject`, { otp, adminNote }),

  cancel: (payoutId: string, otp: string) =>
    api.post(`/payouts/${payoutId}/cancel`, { otp }),

  confirm: (payoutId: string) =>
    api.post(`/payouts/${payoutId}/confirm`),

  dispute: (payoutId: string, shopOwnerNote: string) =>
    api.post(`/payouts/${payoutId}/dispute`, { shopOwnerNote }),

  createManual: (data: {
    shopId: string; shopName: string; amount: number;
    adminNote?: string; otp: string;
  }) => api.post<ShopPayout>('/payouts/manual', data),

  list: (params?: { shopId?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.shopId) query.set('shopId', params.shopId);
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return api.get<unknown>(`/payouts${qs ? `?${qs}` : ''}`)
      .then(d => parseListResponse(payoutSchema, d, 'payoutApi.list') as unknown as ShopPayout[]);
  },
};

// ──────────────────────────────────────────────
// REFUND REQUESTS
// ──────────────────────────────────────────────

export const refundApi = {
  create: (orderId: string, reason: string) =>
    api.post('/refunds', { orderId, reason }),

  /**
   * A shop refunding its own order outright, rather than responding to a claim
   * the student raised. Settles immediately within the server's velocity
   * limits; past them the server escalates to an admin and says so.
   */
  shopRefund: (orderId: string, reason: string) =>
    api.post<{ settled: boolean; escalationReason?: string; amount: number }>(
      '/refunds/shop-refund',
      { orderId, reason }
    ),

  respond: (requestId: string, approved: boolean, shopResponse?: string) =>
    api.post(`/refunds/${requestId}/respond`, { approved, shopResponse }),

  escalate: (requestId: string) =>
    api.post(`/refunds/${requestId}/escalate`),

  resolve: (requestId: string, action: 'APPROVE' | 'DENY', otp: string, adminNote?: string) =>
    api.post(`/refunds/${requestId}/resolve`, { action, otp, adminNote }),

  syncHistory: (orderId: string) =>
    api.get<{ success: boolean; count: number; refunds: unknown }>(`/refunds/history/${orderId}`)
      .then(r => ({
        ...r,
        refunds: parseListResponse(
          refundRequestSchema,
          r.refunds,
          'refundApi.syncHistory'
        ) as unknown as RefundRequest[],
      })),

  list: () => api.get<unknown>('/refunds')
    .then(d => parseListResponse(refundRequestSchema, d, 'refundApi.list') as unknown as RefundRequest[]),
};

// ──────────────────────────────────────────────
// BANK DETAILS & PAYMENT CONFIG
// ──────────────────────────────────────────────

export const bankApi = {
  get: (shopId: string) =>
    api.get<BankDetails | null>(`/shops/${shopId}/bank-details`),

  save: (shopId: string, details: BankDetails) =>
    api.post(`/shops/${shopId}/bank-details`, details),

  verify: (shopId: string) =>
    api.post(`/shops/${shopId}/bank-details/verify`),

  getPaymentConfig: (shopId: string) =>
    api.get<PaymentConfiguration | null>(`/shops/${shopId}/payment-config`),
};

// ──────────────────────────────────────────────
// REACTIVATION REQUESTS
// ──────────────────────────────────────────────

export const reactivationApi = {
  submit: (shopId: string, shopName: string) =>
    api.post<{ success: boolean; message?: string }>('/reactivation/submit', { shopId, shopName }),

  resolve: (requestId: string, action: 'approve' | 'reject', otp: string, rejectionReason?: string) =>
    api.post<{ success: boolean; message?: string }>(`/reactivation/${requestId}/resolve`, { action, otp, rejectionReason }),

  list: () => api.get<unknown>('/reactivation')
    .then(d => parseListResponse(
      reactivationRequestSchema,
      d,
      'reactivationApi.list'
    ) as unknown as ReactivationRequest[]),
};

// ──────────────────────────────────────────────
// ADMIN ACTIONS
// ──────────────────────────────────────────────

export const adminApi = {
  requestOTP: (actionId: string) =>
    api.post<{ success: boolean; message?: string }>('/admin/otp', { actionId }),

  executeAction: (action: string, otp: string, targetUid?: string, targetShopId?: string) =>
    api.post<{ success: boolean; message?: string }>('/admin/action', { action, otp, targetUid, targetShopId }),

  getStudentPassHolders: () =>
    api.get<{ users: unknown }>('/users?type=STUDENT&hasPass=true')
      .then(r => parseListResponse(userSchema, r.users, 'adminApi.getStudentPassHolders') as unknown as {
        id: string; name?: string; email?: string; studentPassActivatedAt?: string; studentPassPaymentId?: string;
      }[]),

  checkReturningShopOwner: (email: string) =>
    api.post<{
      exists: boolean; hasActiveAccount?: boolean; hasArchivedShop?: boolean;
      isOwnerOrphaned?: boolean; oldUserId?: string; shop?: any;
    }>('/admin/check-returning-shop', { email }).then(r => ({
      ...r,
      shop: r.shop ? mapShopProfile(r.shop) : undefined
    })),
};

// ──────────────────────────────────────────────
// REFERRALS (ADMIN ONLY)
// ──────────────────────────────────────────────

export interface ReferralCode {
  id: string;
  code: string;
  /**
   * `createdBy` and `usedBy` are foreign keys that go null when the account is
   * deleted — the code outlives it, so `creator` and `user` are both absent for
   * a row whose account is gone. `usedAt` is what says the code was spent.
   */
  createdBy?: string | null;
  usedBy?: string | null;
  usedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  creator?: { name: string | null; email: string | null } | null;
  user?: { name: string | null; email: string | null; shop?: { name: string } | null } | null;
}

export const referralApi = {
  list: () => api.get<{ codes: unknown }>('/referrals')
    .then(r => parseListResponse(referralCodeSchema, r.codes, 'referralApi.list') as unknown as ReferralCode[]),
  create: (daysValid: number = 7) => api.post<{ code: ReferralCode }>('/referrals', { daysValid }).then(r => r.code),
  delete: (codeId: string) => api.del<{ success: boolean; message: string }>(`/referrals/${codeId}`),
};
