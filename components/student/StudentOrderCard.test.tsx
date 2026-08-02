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

const makeOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'order_1',
  shopId: 'shop_1',
  userId: 'student_1',
  fileName: 'notes.pdf',
  fileType: 'application/pdf',
  status: OrderStatus.PENDING_PAYMENT,
  uploadedAt: '2026-08-01T10:00:00.000Z',
  printOptions: { pages: 12, copies: 1, color: PrintColor.BLACK_WHITE, doubleSided: false },
  priceDetails: { totalPrice: 2400, pageCost: 2000, baseFee: 400 },
  ...overrides,
} as unknown as DocumentOrder);

/** Unpaid, awaiting payment. */
const order = makeOrder();

/** Paid and waiting on the shop — the case that had no cancel button at all. */
const paidOrder = makeOrder({
  status: OrderStatus.PENDING_APPROVAL,
  razorpayPaymentId: 'pay_abc123',
});

const renderCard = (isCancelling?: boolean, subject: DocumentOrder = order) =>
  render(
    <StudentOrderCard
      order={subject}
      onPayNow={vi.fn()}
      onCancelOrder={vi.fn()}
      isCancelling={isCancelling}
    />
  );


describe('A paid order awaiting the shop can still be cancelled', () => {
  /**
   * The regression this pins: cancel used to render only inside the Pay Now
   * box, which a PENDING_APPROVAL order never shows. The server allows the
   * transition and StudentOrderList passes the callback, so the button was the
   * only thing missing — and nothing asserted it was there.
   */
  test('the cancel button is rendered', () => {
    renderCard(false, paidOrder);

    expect(screen.getByRole('button', { name: /cancel order/i })).toBeTruthy();
  });

  test('it does not offer to merely hide an order that was paid for', () => {
    // "Hide" describes an unpaid order vanishing. This one sends money back.
    renderCard(false, paidOrder);

    expect(screen.queryByRole('button', { name: /hide/i })).toBeNull();
  });

  test('there is no Pay Now button to confuse it with', () => {
    renderCard(false, paidOrder);

    expect(screen.queryByRole('button', { name: /pay now|retry payment/i })).toBeNull();
  });

  test('the in-flight state reaches the paid path too', () => {
    // This is the path that does a network round trip and then moves money, so
    // it is the one where a dead-looking tap matters most.
    renderCard(true, paidOrder);

    const cancel = screen.getByRole<HTMLButtonElement>('button', { name: /cancelling/i });
    expect(cancel.disabled).toBe(true);
  });
});

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
