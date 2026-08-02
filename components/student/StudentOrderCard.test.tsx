import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentOrder, OrderStatus, PrintColor } from '../../types';

/**
 * Cancelling an order is two network round trips — a payment-status check
 * before the confirmation dialog, then the cancellation itself — and neither
 * showed anything on the button. On a slow connection the tap read as dead, so
 * the obvious response was to tap it again.
 *
 * The server's compare-and-swap is what actually prevents a double cancel;
 * these tests cover the feedback that stops the student trying.
 */

vi.mock('../../contexts/AppContext', () => ({
  useAppContext: () => ({
    getShopById: () => ({ id: 'shop_1', name: 'Campus Copies' }),
    refundRequests: [],
  }),
}));

let StudentOrderCard: React.ComponentType<{
  order: DocumentOrder;
  onPayNow: (order: DocumentOrder) => void;
  onCancelOrder?: (order: DocumentOrder) => void;
  isProcessingPayment?: boolean;
  isCancelling?: boolean;
}>;

beforeEach(async () => {
  StudentOrderCard = (await import('./StudentOrderCard')).default;
});

const order = {
  id: 'order_1',
  shopId: 'shop_1',
  userId: 'student_1',
  fileName: 'notes.pdf',
  fileType: 'application/pdf',
  status: OrderStatus.PENDING_PAYMENT,
  uploadedAt: '2026-08-01T10:00:00.000Z',
  printOptions: { pages: 12, copies: 1, color: PrintColor.BLACK_WHITE, doubleSided: false },
  priceDetails: { totalPrice: 2400, pageCost: 2000, baseFee: 400 },
} as unknown as DocumentOrder;

const renderCard = (isCancelling?: boolean) =>
  render(
    <StudentOrderCard
      order={order}
      onPayNow={vi.fn()}
      onCancelOrder={vi.fn()}
      isCancelling={isCancelling}
    />
  );

describe('Cancel button feedback', () => {
  test('it invites the tap when nothing is in flight', () => {
    renderCard(false);

    const cancel = screen.getByRole<HTMLButtonElement>('button', { name: /cancel & hide order/i });
    expect(cancel.disabled).toBe(false);
  });

  test('it says what it is doing while the request is in flight', () => {
    renderCard(true);

    expect(screen.getByRole('button', { name: /cancelling/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /cancel & hide order/i })).toBeNull();
  });

  test('it cannot be tapped again while in flight', () => {
    renderCard(true);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: /cancelling/i }).disabled).toBe(true);
  });

  test('paying is blocked while a cancel is resolving', () => {
    // The two outcomes contradict each other, and the cancel round trip is
    // already deciding which one this order gets.
    renderCard(true);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: /pay now/i }).disabled).toBe(true);
  });

  test('paying stays available when no cancel is running', () => {
    renderCard(false);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: /pay now/i }).disabled).toBe(false);
  });
});
