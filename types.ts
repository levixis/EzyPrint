
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
  | 'getPass';
