
export enum UserType {
  STUDENT = 'STUDENT',
  SHOP_OWNER = 'SHOP_OWNER', 
}

export interface User {
  id: string; 
  type: UserType;
  name?: string;
  email?: string; 
  shopId?: string; 
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

export interface DocumentOrder {
  id: string; 
  userId: string; 
  shopId: string; 
  fileName: string;
  fileType: string;
  // fileObject?: File; // Removed: File object will not be stored in Firestore
  fileStoragePath?: string; // Added: Path to the file in Firebase Storage
  fileSizeBytes?: number;   // Added: Size of the uploaded file
  isFileDeleted?: boolean;  // Added: Flag to indicate if file was auto-deleted from storage
  uploadedAt: string; // Timestamp for when the order was created/file info recorded
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
}
