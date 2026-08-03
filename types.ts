
export enum UserType {
  STUDENT = 'STUDENT',
  SHOP_OWNER = 'SHOP_OWNER',
  ADMIN = 'ADMIN',
}

export interface User {
  id: string;
  type: UserType;
  name?: string;
  email?: string;
  phone?: string;
  shopId?: string;
  shopName?: string;
  isShopApproved?: boolean;
  isShopArchived?: boolean;
  isShopRejected?: boolean;
  shopRejectionReason?: string | null;
  hasStudentPass?: boolean;
  studentPassActivatedAt?: string; // ISO date string — pass expires 30 days after this
  studentPassPaymentId?: string;
  fcmTokens?: string[]; // Push notification device tokens
  profilePhotoUrl?: string;
  preferredLanguage?: string;
}

export interface ShopPricing {
  bwPerPage: number;
  colorPerPage: number;
}

// Represents the structure for a single payout option (kept for conceptual clarity if needed elsewhere, but ShopProfile now uses PayoutMethod[])
export interface SinglePayoutDetail {
  accountHolderName?: string;
  accountNumber?: string;
  ifscCode?: string;
  bankName?: string;
  upiId?: string;
}

export type PayoutMethodType = 'BANK_ACCOUNT' | 'UPI';

export interface PayoutMethod {
  id: string; // Unique ID for this payout method
  type: PayoutMethodType;
  accountHolderName?: string; // For BANK_ACCOUNT
  accountNumber?: string;     // For BANK_ACCOUNT
  ifscCode?: string;          // For BANK_ACCOUNT
  bankName?: string;          // For BANK_ACCOUNT
  upiId?: string;             // For UPI
  isPrimary?: boolean;        // Optional: Mark one as primary
  nickname?: string;          // Optional: User-friendly name for this method
}

export interface ShopProfile {
  id: string;
  ownerUserId: string;
  name: string;
  address: string;
  createdAt?: string;
  customPricing: ShopPricing;
  isOpen: boolean;
  isApproved: boolean; // Admin must approve before shop is visible to students
  isArchived?: boolean; // Admin can archive shops — hides from students but keeps data
  isRejected?: boolean;
  rejectionReason?: string | null;
  // Store Contact Info
  contactPhone?: string;
  contactPhoneAlt?: string;
  contactEmail?: string;
  whatsappNumber?: string;
  isVerified?: boolean;
  // Ledger balances
  pendingBalance?: number;
  ledgerBalance?: number;
  debtAmount?: number;
  lastSettlementAt?: string;
  financialVersion?: number;
  // Migration Flags
  migrationVerified?: boolean;
  migratedAt?: string;
}

export enum PrintColor {
  BLACK_WHITE = 'BLACK_WHITE',
  COLOR = 'COLOR',
}

export enum OrderStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  PRINTING = 'PRINTING',
  READY_FOR_PICKUP = 'READY_FOR_PICKUP',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  REFUNDED = 'REFUNDED',
}

export interface PrintOptions {
  copies: number;
  color: PrintColor;
  pages: number;
  doubleSided: boolean;
  startPage?: number;
  endPage?: number;
}

export interface OrderFile {
  fileName: string;
  fileType: string;
  fileStoragePath?: string;
  fileSizeBytes?: number;
  isFileDeleted?: boolean;
  pageCount: number;
  color: PrintColor;
  copies: number;
  doubleSided: boolean;
}

export interface DocumentOrder {
  id: string;
  userId: string;
  shopId: string;
  shopName?: string;
  deletedShop?: boolean;
  fileName: string;      // Legacy: first file name (backward compat)
  fileType: string;       // Legacy: first file type (backward compat)
  fileStoragePath?: string; // Legacy: first file storage path
  fileSizeBytes?: number;   // Legacy: first file size
  isFileDeleted?: boolean;  // Legacy: first file deletion flag
  files?: OrderFile[];      // NEW: array of files in this order
  uploadedAt: string;
  printOptions: PrintOptions;
  status: OrderStatus;
  priceDetails: {
    pageCost: number;
    baseFee: number;
    totalPrice: number;
  };
  shopNotes?: string;
  pickupCode?: string;
  paymentAttemptedAt?: string;
  isPremiumOrder?: boolean; // True if user had Student Pass at order creation
  userName?: string; // Student name stored at order creation for shopkeeper display
  razorpayOrderId?: string; // Razorpay order ID for payment tracking
  razorpayPaymentId?: string; // Razorpay payment ID after successful payment
  specialInstructions?: string; // Optional free-text note from student to shop
  // Refund tracking (written by onOrderStatusChange auto-refund or requestRefund function)
  refundId?: string;
  refundStatus?: string; // "processed", "pending", "FAILED"
  refundAmount?: number;
  refundedAt?: string;
  cancelledAt?: string;
  completedAt?: string;
  refundError?: string;
  refundInitiatedBy?: string;
  refundReason?: string;
  refundProcessingStartedAt?: string;
  // Ledger tracking
  ledgerEntryId?: string; // Links to shopLedger doc for O(1) lookups
  // Payment verification method
  paymentVerifiedVia?: string; // "signature", "api_fallback", "manual_check"
}

export interface NotificationMessage {
  id: string;
  message: string;
  /**
   * Optional because it genuinely can be absent. The server row calls this
   * `createdAt` and the boundary schema maps it across; a notification that
   * arrives with neither name renders without a time rather than with a
   * fabricated one. Defaulting it to the epoch is what made the whole tray
   * read "56y ago".
   */
  timestamp?: string;
  read: boolean;
  orderId?: string;
  type: 'success' | 'info' | 'warning' | 'error';
  targetUserType?: UserType;
  targetUserId?: string;
  targetShopId?: string;
  recipientUserId?: string; // Resolved user ID for Firestore routing
}

export enum PayoutStatus {
  PENDING = 'PENDING',
  /** Approved and sent to the bank, not yet credited. Shown as "on its way". */
  IN_TRANSIT = 'IN_TRANSIT',
  PAID = 'PAID',
  CONFIRMED = 'CONFIRMED',
  DISPUTED = 'DISPUTED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export interface ShopPayout {
  id: string;
  shopId: string;
  shopName: string;
  amount: number;
  payoutOrderIds?: string[];
  adminNote?: string;
  shopOwnerNote?: string;
  status: PayoutStatus;
  createdAt: string;
  paidAt?: string;
  confirmedAt?: string;
}

export type AppView =
  | 'landing'
  | 'login'
  | 'studentDashboard'
  | 'shopDashboard'
  | 'adminDashboard'
  | 'privacy'
  | 'terms'
  | 'refund'
  | 'shipping'
  | 'contact'
  | 'getPass';

// --- Bank Details (stored in shops/{shopId}/private/bankDetails sub-collection) ---
export type BankAccountType = 'SAVINGS' | 'CURRENT';

export interface BankDetails {
  accountHolderName: string;
  bankName: string;
  accountNumber: string; // Masked in UI, stored plain in restricted sub-collection
  ifscCode: string;
  accountType: BankAccountType;
  upiId?: string;
  isVerified?: boolean; // Admin sets this
  verifiedAt?: string;
  verifiedBy?: string;
  updatedAt?: string;
}

// --- Payment Config (stored in shops/{shopId}/private/paymentConfig sub-collection) ---
export interface PaymentConfiguration {
  payoutMethods: PayoutMethod[];
  updatedAt?: string;
}

export interface BankAccessLog {
  id: string;
  userId: string;
  userRole: UserType;
  action: 'VIEW' | 'EDIT' | 'VERIFY';
  timestamp: string;
  ip?: string;
}

// --- Support Ticket System ---
export enum TicketCategory {
  ORDER_ISSUE = 'ORDER_ISSUE',
  PAYMENT_ISSUE = 'PAYMENT_ISSUE',
  DELIVERY_ISSUE = 'DELIVERY_ISSUE',
  OTHER = 'OTHER',
}

export enum TicketStatus {
  OPEN = 'OPEN',
  IN_REVIEW = 'IN_REVIEW',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export interface TicketMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderType: UserType; // STUDENT, SHOP_OWNER, or ADMIN
  message: string;
  /** The server sends `createdAt`; `timestamp` is the older client-side name. */
  createdAt?: string;
  timestamp?: string;
}

export interface TicketStatusChange {
  from: TicketStatus;
  to: TicketStatus;
  changedBy: string;
  changedByName: string;
  /** The server sends `createdAt`; `timestamp` is the older client-side name. */
  createdAt?: string;
  timestamp?: string;
  note?: string;
}

export interface TicketAttachment {
  /** The reply this file was sent with; absent for ticket-level attachments. */
  messageId?: string | null;
  id: string;
  ticketId: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes?: number;
  uploadId?: string;
  createdAt: string;
}

export interface SupportTicket {
  id: string;
  raisedBy: string; // userId
  raisedByType: UserType;
  raisedByName: string;
  raisedByEmail?: string;
  shopId?: string; // Only for shop-owner tickets
  shopName?: string;
  deletedShop?: boolean;
  relatedOrderId?: string;
  subject: string;
  category: TicketCategory;
  description: string;
  status: TicketStatus;
  attachmentPaths?: string[]; // Legacy
  attachments?: TicketAttachment[];
  /**
   * Optional because the list endpoint does not send the full thread — only
   * the detail endpoint does. Typing it as required let TicketList read
   * `.length` on undefined and blank the whole page.
   */
  messages?: TicketMessage[];
  /** Total messages, sent by the list endpoint so it need not ship the thread. */
  messageCount?: number;
  /** Optional for the same reason as `messages` — not every endpoint sends it. */
  statusHistory?: TicketStatusChange[];
  createdAt: string;
  updatedAt: string;
  adminLastRepliedAt?: string;
  raiserLastRepliedAt?: string;
  shopLastRepliedAt?: string;
  attachmentsCleanedAt?: string;
}

// --- Earnings Reports ---
export interface EarningsReport {
  id: string;
  type: string;
  startDate: string;
  endDate: string;
  totalOrders: number;
  totalRevenue: number;
  totalBaseFees: number;
  totalPageCosts: number;
  storagePath: string;
  downloadUrl: string;
  generatedAt: string;
  generatedBy: string;
}

// --- Reactivation Requests ---
export type ReactivationRequestStatus = 'pending' | 'approved' | 'rejected';

export interface ReactivationRequest {
  id: string;
  shopId: string;
  ownerUid: string;
  ownerEmail: string;
  ownerName: string;
  shopName: string;
  requestedAt: string;
  status: ReactivationRequestStatus;
  resolvedAt?: string;
  resolvedBy?: string;
  rejectionReason?: string;
}

// --- Ledger System ---
export enum LedgerEntryType {
  ORDER_EARNING = 'ORDER_EARNING',
  REFUND_DEDUCTION = 'REFUND_DEDUCTION',
  PAYOUT = 'PAYOUT',
  MANUAL_PAYOUT_DEDUCTION = 'MANUAL_PAYOUT_DEDUCTION',
  PAYOUT_CANCEL_REFUND = 'PAYOUT_CANCEL_REFUND',
  PAYOUT_REJECT_REFUND = 'PAYOUT_REJECT_REFUND',
  CLAWBACK = 'CLAWBACK',
  ADJUSTMENT = 'ADJUSTMENT',
}

export enum LedgerEntryStatus {
  PENDING = 'PENDING',   // Within settlement window (24h)
  SETTLED = 'SETTLED',   // Claimable — moved to ledgerBalance
  VOID = 'VOID',         // Refunded during pending window
}

export type LedgerCounterparty = 'PLATFORM' | 'SHOP' | 'STUDENT';

export interface ShopLedgerEntry {
  id: string;
  eventId?: string; // Deterministic dedup key (e.g. earn_<orderId>, refund_<orderId>, payout_<payoutId>)
  shopId: string;
  orderId?: string;
  type: LedgerEntryType;
  status: LedgerEntryStatus;
  amount: number;
  counterparty: LedgerCounterparty;
  description: string;
  createdBy: 'SYSTEM' | 'ADMIN' | 'SHOP';
  createdAt: string;
  settledAt?: string;
}

export interface ShopAggregate {
  shopId: string;
  totalOrders: number;
  activeOrders: number;
  completedOrders: number;
  totalRevenue: number;
  totalBaseFees: number;
  totalPaidOut: number;
  pendingPayouts: number;
  pendingPayoutCount: number;
  updatedAt?: string;
}

// --- Refund Requests ---
export enum RefundRequestStatus {
  PENDING_SHOP = 'PENDING_SHOP',
  APPROVED_BY_SHOP = 'APPROVED_BY_SHOP',
  REJECTED_BY_SHOP = 'REJECTED_BY_SHOP',
  ESCALATED_TO_ADMIN = 'ESCALATED_TO_ADMIN',
  AUTO_ESCALATED = 'AUTO_ESCALATED',
  RESOLVED_REFUNDED = 'RESOLVED_REFUNDED',
  RESOLVED_DENIED = 'RESOLVED_DENIED',
}

export interface RefundRequest {
  id: string;
  orderId: string;
  studentId: string;
  shopId: string;
  reason: string;
  status: RefundRequestStatus;
  refundAmount?: number;
  razorpayRefundId?: string;
  studentRequestedAt: string;
  shopRespondedAt?: string;
  shopResponse?: string;
  adminResolvedAt?: string;
  adminNote?: string;
  resolvedBy?: string;
}

export interface RazorpayRefund {
  id: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed' | string;
  created_at: number;
  payment_id: string;
  notes?: Record<string, string>;
  receipt?: string;
  acquirer_data?: {
    arn?: string;
  };
}
