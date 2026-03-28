
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
  shopId?: string;
  hasStudentPass?: boolean;
  studentPassActivatedAt?: string; // ISO date string — pass expires 30 days after this
  fcmTokens?: string[]; // Push notification device tokens
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
  customPricing: ShopPricing;
  isOpen: boolean;
  isApproved: boolean; // Admin must approve before shop is visible to students
  isArchived?: boolean; // Admin can archive shops — hides from students but keeps data
  payoutMethods?: PayoutMethod[]; // Updated to support multiple payout methods
  // Store Contact Info
  contactPhone?: string;
  contactPhoneAlt?: string;
  contactEmail?: string;
  whatsappNumber?: string;
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
  refundError?: string;
  // Payment verification method
  paymentVerifiedVia?: string; // "signature", "api_fallback", "manual_check"
}

export interface NotificationMessage {
  id: string;
  message: string;
  timestamp: string;
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
  PAID = 'PAID',
  CONFIRMED = 'CONFIRMED',
  DISPUTED = 'DISPUTED',
}

export interface ShopPayout {
  id: string;
  shopId: string;
  shopName: string;
  amount: number;
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
  | 'getPass'
  | 'tickets';

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
  timestamp: string;
}

export interface TicketStatusChange {
  from: TicketStatus;
  to: TicketStatus;
  changedBy: string;
  changedByName: string;
  timestamp: string;
  note?: string;
}

export interface SupportTicket {
  id: string;
  raisedBy: string; // userId
  raisedByType: UserType;
  raisedByName: string;
  raisedByEmail?: string;
  shopId?: string; // Only for shop-owner tickets
  relatedOrderId?: string;
  subject: string;
  category: TicketCategory;
  description: string;
  status: TicketStatus;
  attachmentPaths: string[]; // Firebase Storage paths
  messages: TicketMessage[];
  statusHistory: TicketStatusChange[];
  createdAt: string;
  updatedAt: string;
  adminLastRepliedAt?: string;
  raiserLastRepliedAt?: string;
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
