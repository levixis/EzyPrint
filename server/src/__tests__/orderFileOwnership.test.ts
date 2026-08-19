/**
 * A storage key must never arrive from the request body.
 *
 * `Order.fileStoragePath` / `OrderFile.fileStoragePath` are proof of
 * possession: `verifyStorageAccess` resolves a key back to an owner to decide
 * who may download a document. So a caller who can attach an arbitrary key to
 * an order they own can read whoever else's file that key belongs to — and the
 * bucket holds scanned IDs, notarised papers and coursework.
 *
 * `createOrderSchema` also drops the field, and that is deliberately NOT what
 * these tests rely on. `validate` parses the request for errors and never
 * writes the parsed body back, so Zod's stripping does not reach the handler,
 * and `order.controller` spreads `...req.body` straight into this service. The
 * allowlist inside `createOrder` is the control that actually holds, and it is
 * the one pinned here — a test that went through the schema would pass while
 * the real path stayed open, which is exactly how this was missed the first
 * time.
 */

const mockShopFindUnique = jest.fn();
const mockUserFindUnique = jest.fn();
const mockOrderCreate = jest.fn();

jest.mock('../utils/prisma', () => ({
  prisma: {
    shop: { findUnique: mockShopFindUnique },
    user: { findUnique: mockUserFindUnique },
    order: { create: mockOrderCreate },
  },
}));

jest.mock('../services/settlement.service', () => ({ creditOrderEarning: jest.fn() }));
jest.mock('../services/realtime.service', () => ({
  enqueueShopEvent: jest.fn(),
  publishQueued: jest.fn(),
}));
jest.mock('../services/refund.service', () => ({
  claimCancellationRefund: jest.fn(),
  settleClaimedRefund: jest.fn(),
}));
jest.mock('../services/cleanup.service', () => ({
  purgeOrderFiles: jest.fn(),
  isTerminalForFiles: jest.fn().mockReturnValue(false),
}));
jest.mock('../services/notify.service', () => ({
  notifyOrderStatus: jest.fn(),
  notifyEarningCredited: jest.fn(),
  notifyNewOrder: jest.fn(),
  notifyAdmins: jest.fn(),
}));

import { createOrder } from '../services/order.service';

/** The shape `order.controller` produces: `{ ...req.body, userId, userName }`. */
const requestFrom = (fileOverrides: Record<string, unknown>) => ({
  userId: 'student_attacker',
  shopId: 'shop_1',
  files: [
    {
      fileName: 'mine.pdf',
      fileType: 'application/pdf',
      pageCount: 1,
      color: 'BLACK_WHITE' as const,
      copies: 1,
      doubleSided: false,
      ...fileOverrides,
    },
  ],
});

beforeEach(() => {
  jest.clearAllMocks();

  mockShopFindUnique.mockResolvedValue({
    id: 'shop_1',
    name: 'Shop',
    isApproved: true,
    isOpen: true,
    isArchived: false,
    bwPerPage: 100,
    colorPerPage: 300,
  });
  mockUserFindUnique.mockResolvedValue({ hasStudentPass: false, studentPassActivatedAt: null });
  mockOrderCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'order_1',
    files: [],
    ...data,
  }));
});

/** What `createOrder` actually asked Prisma to write. */
const written = () => mockOrderCreate.mock.calls[0][0].data;

describe('a storage key supplied by the caller is ignored', () => {
  test("the victim's key is not written to the order file", async () => {
    await createOrder(
      requestFrom({ fileStoragePath: 'orders/1699-abc-victim-id-scan.pdf' }) as never
    );

    const createdFiles = written().files.create;
    expect(createdFiles).toHaveLength(1);
    expect(createdFiles[0].fileStoragePath).toBeUndefined();
  });

  test("the victim's key is not written to the order's denormalised copy", async () => {
    // `Order.fileStoragePath` mirrors the first file, and `verifyStorageAccess`
    // resolves order files — leaving this populated would reopen the same hole
    // through the other column.
    await createOrder(
      requestFrom({ fileStoragePath: 'orders/1699-abc-victim-id-scan.pdf' }) as never
    );

    expect(written().fileStoragePath).toBeUndefined();
  });

  test('the legitimate fields still make it through', async () => {
    // The allowlist must not be so tight that ordinary orders lose data.
    await createOrder(requestFrom({}) as never);

    const file = written().files.create[0];
    expect(file).toMatchObject({
      fileName: 'mine.pdf',
      fileType: 'application/pdf',
      pageCount: 1,
      color: 'BLACK_WHITE',
      copies: 1,
      doubleSided: false,
    });
  });

  test('nothing else the caller invents is written either', async () => {
    // The allowlist is what makes this true for every field at once, rather
    // than only for the one that was exploited.
    await createOrder(
      requestFrom({ isFileDeleted: true, verifiedPageCount: 9999, id: 'someone-elses-row' }) as never
    );

    const file = written().files.create[0];
    expect(file.isFileDeleted).toBeUndefined();
    expect(file.verifiedPageCount).toBeUndefined();
    expect(file.id).toBeUndefined();
  });
});
