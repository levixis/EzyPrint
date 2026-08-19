/**
 * An order's files are frozen once it has been paid for.
 *
 * An order's price is fixed at the moment its Razorpay order is created:
 * `repriceFromVerifiedPages` runs once, before the gateway call, and nothing
 * re-prices afterwards. So "the file the order was charged for" and "the file
 * the shop is handed" are only the same thing if the second one cannot change.
 *
 * It could. `POST /uploads/single` checked that the caller owned the order and
 * nothing else, so `replace=true` accepted a new file in any state — pay for a
 * one-page document, swap in a two-hundred-page one, and the shop prints two
 * hundred pages having been credited `pageCost` for one. The same key let the
 * content be swapped after the shop had approved it.
 *
 * `deleteFileHandler` had enforced this rule since the delete path was fixed;
 * the upload path was the half of the pair that was missed. Both now go through
 * `assertOrderAcceptsFileChanges`, and these tests pin the rule from both ends
 * so it cannot be reinstated on one side alone.
 */

const mockOrderFindUnique = jest.fn();
const mockOrderFileFindUnique = jest.fn();
const mockOrderFileFindMany = jest.fn();
const mockOrderFileFindFirst = jest.fn();
const mockOrderFileUpdate = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockTicketAttachmentFindMany = jest.fn();
const mockTicketAttachmentDeleteMany = jest.fn();
const mockTransaction = jest.fn();
const mockQueryRaw = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    order: { findUnique: mockOrderFindUnique, updateMany: mockOrderUpdateMany },
    orderFile: {
      findUnique: mockOrderFileFindUnique,
      findMany: mockOrderFileFindMany,
      findFirst: mockOrderFileFindFirst,
      update: mockOrderFileUpdate,
    },
    ticketAttachment: {
      findMany: mockTicketAttachmentFindMany,
      deleteMany: mockTicketAttachmentDeleteMany,
    },
    $transaction: mockTransaction,
  },
}));

const mockUploadFile = jest.fn();
const mockDeleteFile = jest.fn();
jest.mock('../services/storage.service', () => ({
  uploadFile: mockUploadFile,
  deleteFile: mockDeleteFile,
  getDownloadUrl: jest.fn(),
  getFileBuffer: jest.fn(),
}));

const mockCountPages = jest.fn();
jest.mock('../services/pagecount.service', () => ({ countPages: mockCountPages }));

import { uploadSingle, uploadMultiple, deleteFileHandler } from '../controllers/upload.controller';
import type { OrderStatus } from '@prisma/client';

const STUDENT = { userId: 'student_1', userType: 'STUDENT' as const };
const ADMIN = { userId: 'admin_1', userType: 'ADMIN' as const };

/**
 * An order owned by STUDENT, sitting in `status`, with one already-stored file
 * and *no* checkout started.
 *
 * The two payment fields are explicitly null rather than absent, because that
 * is what a real row looks like and because the guard fails closed on a missing
 * field. Keeping them null in the base fixture isolates the two rules: the
 * status tests below exercise the status rule alone, and the checkout-window
 * tests set these fields to exercise the price-quoted rule alone.
 */
const orderIn = (status: OrderStatus) => ({
  id: 'order_1',
  userId: STUDENT.userId,
  status,
  razorpayOrderId: null,
  paymentAttemptedAt: null,
  files: [
    {
      id: 'file_1',
      uploadId: 'upload_original',
      fileStoragePath: 'orders/1699-original.pdf',
    },
  ],
});

function fakeRes() {
  const res: Record<string, jest.Mock> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

/** Drive `uploadSingle` and hand back whatever it did. */
async function runUploadSingle(opts: {
  user: { userId: string; userType: string };
  uploadId?: string;
  replace?: string;
}) {
  const req = {
    file: { buffer: Buffer.from('%PDF-1.4 two hundred pages'), originalname: 'swapped.pdf', mimetype: 'application/pdf' },
    query: {},
    body: {
      metadata: JSON.stringify({ orderId: 'order_1', fileIndex: 0 }),
      uploadId: opts.uploadId ?? 'upload_new',
      ...(opts.replace ? { replace: opts.replace } : {}),
    },
    user: opts.user,
  };
  const res = fakeRes();
  const next = jest.fn();
  await uploadSingle(req as never, res as never, next);
  return { res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOrderFileFindUnique.mockResolvedValue(null);
  mockUploadFile.mockResolvedValue({
    storageKey: 'orders/1699-swapped.pdf',
    originalName: 'swapped.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
  });
  mockCountPages.mockResolvedValue({ pages: 200, counted: true });
  mockDeleteFile.mockResolvedValue(undefined);
  mockOrderFileUpdate.mockResolvedValue({});
  mockOrderUpdateMany.mockResolvedValue({ count: 1 });
  // Stands in for `SELECT ... FOR UPDATE`: by default the row is unchanged
  // since the pre-check, which is the ordinary case.
  mockQueryRaw.mockImplementation(async () => {
    const order = await mockOrderFindUnique();
    if (!order) return [];
    return [{
      status: order.status,
      razorpayOrderId: order.razorpayOrderId ?? null,
      paymentAttemptedAt: order.paymentAttemptedAt ?? null,
    }];
  });
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ orderFile: { update: mockOrderFileUpdate }, $queryRaw: mockQueryRaw })
  );
});

/** Every state in which money has moved or a job is with the shop. */
const FROZEN: OrderStatus[] = ['PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP', 'COMPLETED'];

describe('replacing a file on an order that has been paid for', () => {
  test.each(FROZEN)('is refused once the order is %s', async (status) => {
    mockOrderFindUnique.mockResolvedValue(orderIn(status));

    const { next } = await runUploadSingle({ user: STUDENT, replace: 'true' });

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    // The point of the guard: nothing reached storage or the row.
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockOrderFileUpdate).not.toHaveBeenCalled();
  });

  test('is refused even though the caller genuinely owns the order', async () => {
    // Ownership was the only check there was, and it passes here — which is
    // exactly why it was not sufficient on its own.
    mockOrderFindUnique.mockResolvedValue(orderIn('PRINTING'));

    const { next } = await runUploadSingle({ user: STUDENT, replace: 'true' });

    expect(next.mock.calls[0][0].message).toMatch(/no longer be replaced/i);
  });
});

describe('the flows that must keep working', () => {
  test('a first upload while the order is still PENDING_PAYMENT succeeds', async () => {
    mockOrderFindUnique.mockResolvedValue({
      ...orderIn('PENDING_PAYMENT'),
      files: [{ id: 'file_1', uploadId: null, fileStoragePath: null }],
    });

    const { res, next } = await runUploadSingle({ user: STUDENT });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockOrderFileUpdate).toHaveBeenCalled();
  });

  test('re-uploading after a failed payment succeeds — that is the retry path', async () => {
    // PAYMENT_FAILED is reopenable by `createPaymentOrder`, so the student must
    // still be able to fix whatever they are retrying with.
    mockOrderFindUnique.mockResolvedValue(orderIn('PAYMENT_FAILED'));

    const { res, next } = await runUploadSingle({ user: STUDENT, replace: 'true' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('a retry of an upload that already landed still returns 200 on a paid order', async () => {
    // The guard sits after the idempotent return on purpose. A client retrying
    // through a flaky connection while the payment webhook lands is repeating
    // work already done, not changing anything, and must not be refused.
    mockOrderFindUnique.mockResolvedValue(orderIn('PENDING_APPROVAL'));
    mockOrderFileFindUnique.mockResolvedValue({
      id: 'file_1',
      fileStoragePath: 'orders/1699-original.pdf',
    });

    const { res, next } = await runUploadSingle({ user: STUDENT, uploadId: 'upload_original' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  test('an admin may still replace a file on a printing order', async () => {
    // Admins are who resolve the cases that need this.
    mockOrderFindUnique.mockResolvedValue(orderIn('PRINTING'));

    const { res, next } = await runUploadSingle({ user: ADMIN, replace: 'true' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('the checkout window — an order still PENDING_PAYMENT but already priced', () => {
  /**
   * The status guard alone is not enough, and this is the sequence that proves
   * it. `PENDING_PAYMENT` is the status for the *entire* time the Razorpay
   * checkout sheet is open, so every step below is legal:
   *
   *   1. upload a 1-page file          → verifiedPageCount = 1
   *   2. POST /payments/create-order   → repriced to 1 page, Razorpay order
   *                                      created for that amount, order row
   *                                      still PENDING_PAYMENT
   *   3. upload replace=true, 200 pages → status is *still* PENDING_PAYMENT
   *   4. pay the amount from step 2    → payment.amount === order.totalPrice,
   *                                      so the webhook fulfils it
   *
   * The shop prints 200 pages for the price of one and nothing anywhere
   * disagrees. The signal that matters is not the status — it is that a
   * payment has been claimed and a price quoted.
   */
  const atCheckout = (overrides: Record<string, unknown> = {}) => ({
    ...orderIn('PENDING_PAYMENT'),
    razorpayOrderId: 'order_RzpLive123',
    paymentAttemptedAt: new Date(),
    ...overrides,
  });

  test('replacing a file while the Razorpay checkout is open is refused', async () => {
    mockOrderFindUnique.mockResolvedValue(atCheckout());

    const { next } = await runUploadSingle({ user: STUDENT, replace: 'true' });

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  test('a payment claimed seconds ago but with no Razorpay order yet also locks the files', async () => {
    // `createPaymentOrder` sets `paymentAttemptedAt` *before* it calls Razorpay
    // and writes `razorpayOrderId` only after. Guarding on the id alone leaves
    // that gap open, and it is the whole window an attacker aims at.
    mockOrderFindUnique.mockResolvedValue(
      atCheckout({ razorpayOrderId: null, paymentAttemptedAt: new Date() })
    );

    const { next } = await runUploadSingle({ user: STUDENT, replace: 'true' });

    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
  });

  test('waiting out the claim TTL does NOT reopen a live Razorpay checkout', async () => {
    /**
     * The obvious way to defeat a TTL: open checkout, wait for the internal
     * claim to lapse, then swap the file and pay the original still-valid
     * Razorpay order.
     *
     * Razorpay's order does not expire when our claim does, and nothing in the
     * upload path reprices `totalPrice` or clears `razorpayOrderId` — verified
     * by grep, there is no `data: { razorpayOrderId: null }` anywhere and the
     * only writer of `totalPrice` is `repriceFromVerifiedPages`, which
     * `createPaymentOrder` calls only while `razorpayOrderId` is still null. So
     * if the TTL alone released the files, the old id and old amount would both
     * survive and the webhook would match exactly as before.
     *
     * It does not, because the gate is an OR: a set `razorpayOrderId` refuses
     * regardless of how old the claim is. The TTL only ever releases an order
     * whose claim was made but never turned into a gateway order — a crashed
     * attempt, which `createPaymentOrder` is itself allowed to reclaim.
     */
    mockOrderFindUnique.mockResolvedValue(
      atCheckout({
        razorpayOrderId: 'order_RzpStillValid',
        paymentAttemptedAt: new Date(Date.now() - 10 * 60 * 1000), // long lapsed
      })
    );

    const { next } = await runUploadSingle({ user: STUDENT, replace: 'true' });

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(next.mock.calls[0][0].message).toMatch(/already at checkout/i);
    expect(mockUploadFile).not.toHaveBeenCalled();
    expect(mockOrderFileUpdate).not.toHaveBeenCalled();
  });

  test('an abandoned claim older than the reclaim window releases the files again', async () => {
    // Same 60s TTL `createPaymentOrder` uses to let a crashed attempt be
    // retried. If it may reclaim the order, uploads may change it.
    mockOrderFindUnique.mockResolvedValue(
      atCheckout({ razorpayOrderId: null, paymentAttemptedAt: new Date(Date.now() - 120_000) })
    );

    const { res, next } = await runUploadSingle({ user: STUDENT, replace: 'true' });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('a failed payment that still holds its Razorpay order keeps its files locked', async () => {
    // The retry path reuses the same Razorpay order at the same amount, so the
    // file set it was priced from must not move underneath it. Changing the
    // basket means cancelling and starting again — nothing has been charged.
    mockOrderFindUnique.mockResolvedValue({
      ...orderIn('PAYMENT_FAILED'),
      razorpayOrderId: 'order_RzpLive123',
      paymentAttemptedAt: new Date(Date.now() - 600_000),
    });

    const { next } = await runUploadSingle({ user: STUDENT, replace: 'true' });

    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
  });

  test('a checkout that starts *during* the upload still loses the race', async () => {
    // The pre-check reads an unclaimed order and passes; the bytes then go to
    // R2, which takes long enough for a concurrent POST /payments/create-order
    // to claim the order and quote a price from the old file set. The re-check
    // under `FOR UPDATE` is the thing that catches it — without it the write
    // lands after the price is fixed, which is the exploit with extra steps.
    mockOrderFindUnique.mockResolvedValue(orderIn('PENDING_PAYMENT'));
    mockQueryRaw.mockResolvedValue([
      { status: 'PENDING_PAYMENT', razorpayOrderId: 'order_RzpRaced', paymentAttemptedAt: new Date() },
    ]);

    const { next } = await runUploadSingle({ user: STUDENT, replace: 'true' });

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    // The row was never written, and the orphaned object was cleaned up.
    expect(mockOrderFileUpdate).not.toHaveBeenCalled();
    expect(mockDeleteFile).toHaveBeenCalledWith('orders/1699-swapped.pdf');
  });

  test('the partial-upload retry still works, because checkout cannot have started', async () => {
    // `createPaymentOrder` refuses while any file lacks a verified page count,
    // so an order with an unfilled slot can never hold a Razorpay order. This
    // is the flow that was once permanently unpayable; it must stay open.
    mockOrderFindUnique.mockResolvedValue({
      ...orderIn('PENDING_PAYMENT'),
      razorpayOrderId: null,
      paymentAttemptedAt: null,
      files: [{ id: 'file_1', uploadId: null, fileStoragePath: null }],
    });

    const { res, next } = await runUploadSingle({ user: STUDENT });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('the multi-file path carries the same rule', () => {
  async function runUploadMultiple(status: OrderStatus, user: { userId: string; userType: string }) {
    mockOrderFindUnique.mockResolvedValue(orderIn(status));
    mockOrderFileFindMany.mockResolvedValue([]);

    const req = {
      files: [{ buffer: Buffer.from('%PDF'), originalname: 'swapped.pdf', mimetype: 'application/pdf' }],
      query: {},
      body: {
        metadata: JSON.stringify({ orderId: 'order_1', fileIndexes: [0] }),
        uploadIds: JSON.stringify(['upload_new']),
        replace: 'true',
      },
      user,
    };
    const res = fakeRes();
    const next = jest.fn();
    await uploadMultiple(req as never, res as never, next);
    return { res, next };
  }

  test('a batch replace on a printing order is refused', async () => {
    // The single-file endpoint being fixed alone would leave the identical hole
    // one route over — which is how this class of bug survives a fix.
    const { next } = await runUploadMultiple('PRINTING', STUDENT);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  test('a batch upload before payment still succeeds', async () => {
    const { res, next } = await runUploadMultiple('PENDING_PAYMENT', STUDENT);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('the delete path is still guarded by the same rule', () => {
  async function runDelete(status: OrderStatus) {
    // `verifyStorageAccess` resolves the key to exactly one owning row.
    mockOrderFileFindMany.mockResolvedValue([
      { id: 'file_1', fileStoragePath: 'orders/1699-original.pdf', order: { userId: STUDENT.userId, shop: null } },
    ]);
    mockTicketAttachmentFindMany.mockResolvedValue([]);
    mockOrderFileFindFirst.mockResolvedValue({
      id: 'file_1',
      orderId: 'order_1',
      order: { status, razorpayOrderId: null, paymentAttemptedAt: null },
    });
    mockDeleteFile.mockResolvedValue(undefined);

    const req = {
      params: { storageKey: encodeURIComponent('orders/1699-original.pdf') },
      user: STUDENT,
    };
    const res = fakeRes();
    const next = jest.fn();
    await deleteFileHandler(req as never, res as never, next);
    return { res, next };
  }

  test('deleting a file on a printing order is still refused', async () => {
    // Sharing the helper must not have loosened the rule the delete path
    // already enforced.
    const { next } = await runDelete('PRINTING');

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(next.mock.calls[0][0].message).toMatch(/no longer be removed/i);
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  test('deleting a file before payment still works', async () => {
    const { next } = await runDelete('PENDING_PAYMENT');

    expect(next).not.toHaveBeenCalled();
    expect(mockDeleteFile).toHaveBeenCalledWith('orders/1699-original.pdf');
  });
});
