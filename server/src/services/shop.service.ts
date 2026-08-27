import { prisma } from '../utils/prisma';
import { ApiError } from '../utils/ApiError';
import { isUsablePageRate, pageRateFloorMessage } from './pricing.service';

/**
 * Shop Service — CRUD, admin actions, settings, and aggregate stats.
 */

/**
 * Everything about a shop, balances included.
 *
 * Only ever for the shop's own owner or an admin. `pendingBalance`,
 * `ledgerBalance` and `debtAmount` are the shop's money, and `rejectionReason`
 * is a private note about why an application was turned down.
 */
const shopSelect = {
  id: true,
  ownerUserId: true,
  name: true,
  address: true,
  bwPerPage: true,
  colorPerPage: true,
  isOpen: true,
  isApproved: true,
  isArchived: true,
  isVerified: true,
  isRejected: true,
  rejectionReason: true,
  contactPhone: true,
  contactPhoneAlt: true,
  contactEmail: true,
  whatsappNumber: true,
  pendingBalance: true,
  ledgerBalance: true,
  debtAmount: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * What anyone may see about a shop.
 *
 * A student choosing where to print needs the name, where it is, what it
 * charges, whether it is open, and how to contact it. Nothing else on the row
 * is any of their business.
 *
 * This exists because `GET /shops/:shopId` had no `authenticate` on it and
 * returned the full row plus `payoutMethods` and the owner's email — so an
 * anonymous caller holding a shop id, which the public shop list hands out,
 * could read that shop's bank account number, IFSC code, UPI id and balances.
 * The fields have a properly guarded endpoint of their own
 * (`GET /shops/:shopId/bank-details`); this route was quietly bypassing it.
 */
const publicShopSelect = {
  id: true,
  name: true,
  address: true,
  bwPerPage: true,
  colorPerPage: true,
  isOpen: true,
  isApproved: true,
  isArchived: true,
  contactPhone: true,
  contactEmail: true,
  whatsappNumber: true,
} as const;

// ────────────────────────────────────────────────────────────
// READ
// ────────────────────────────────────────────────────────────

/**
 * List shops visible to students — approved, not archived.
 * Optionally filter by isOpen.
 *
 * `includeOwnedBy` additionally returns that user's own shop whatever state it
 * is in — archived, closed, or not yet approved. Pass it only for the owner
 * themselves; the projection is the public one either way, so this widens who
 * sees a row, never what the row contains.
 *
 * Without it, archiving a shop locked its owner out of the app entirely. The
 * client picks between the dashboard, the pending-approval screen and the
 * reactivation banner by looking its own shop up in this list, and an archived
 * shop was never in it — so the owner sat on "Loading your shop dashboard…"
 * forever and the one screen offering "Request Reactivation" was unreachable.
 * Archiving is meant to be appealable; it was a silent one-way door.
 */
export async function listShopsForStudents(options?: { onlyOpen?: boolean; includeOwnedBy?: string }) {
  const visible: Record<string, unknown> = {
    isApproved: true,
    isArchived: false,
  };

  if (options?.onlyOpen) {
    visible.isOpen = true;
  }

  // The owner's branch carries no isOpen/isApproved/isArchived filter, so their
  // shop survives every combination of those flags — which is the whole point.
  const where = options?.includeOwnedBy
    ? { OR: [visible, { ownerUserId: options.includeOwnedBy }] }
    : visible;

  return prisma.shop.findMany({
    where,
    select: {
      id: true,
      name: true,
      address: true,
      bwPerPage: true,
      colorPerPage: true,
      isOpen: true,
      isApproved: true,
      isArchived: true,
      contactPhone: true,
      contactEmail: true,
      whatsappNumber: true,
    },
    orderBy: [{ isOpen: 'desc' }, { name: 'asc' }],
  });
}

/**
 * Admin: list ALL shops (including unapproved and archived).
 */
export async function listAllShops() {
  return prisma.shop.findMany({
    select: {
      ...shopSelect,
      owner: {
        select: { id: true, name: true, email: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Get a single shop by ID, projected to what the caller is entitled to.
 *
 * The privileged shape — balances, payout methods, the owner's email, the
 * private rejection reason — is for the owner and admins only. Everyone else,
 * including anonymous callers, gets the same public view the shop list returns.
 *
 * Deciding this here rather than in the route is deliberate: the route is where
 * it was decided before, by omission, and the answer was "everything to
 * everyone". A caller now has to present an identity to widen the projection,
 * and passing no requester can only ever narrow it.
 */
export async function getShopById(
  shopId: string,
  requester?: { userId: string; userType: string }
) {
  // Two queries would race an ownership change between them, and the owner
  // check needs a field the public projection deliberately omits — so read the
  // owner id, decide, and only then choose what to return.
  const owner = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { ownerUserId: true },
  });

  if (!owner) throw ApiError.notFound('Shop not found');

  const privileged =
    requester?.userType === 'ADMIN' ||
    (requester != null && requester.userId === owner.ownerUserId);

  if (!privileged) {
    const publicShop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: publicShopSelect,
    });
    if (!publicShop) throw ApiError.notFound('Shop not found');
    return publicShop;
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      ...shopSelect,
      owner: {
        select: { id: true, name: true, email: true },
      },
      payoutMethods: true,
    },
  });

  if (!shop) {
    throw ApiError.notFound('Shop not found');
  }

  return shop;
}

/**
 * Get the shop owned by a specific user.
 */
export async function getShopByOwnerId(ownerUserId: string) {
  return prisma.shop.findUnique({
    where: { ownerUserId },
    select: shopSelect,
  });
}

// ────────────────────────────────────────────────────────────
// UPDATE
// ────────────────────────────────────────────────────────────

/**
 * Shop owner updates their shop settings (pricing, open/close, contact info).
 * Validates that the user owns the shop.
 */
export async function updateShopSettings(
  shopId: string,
  ownerUserId: string,
  data: {
    bwPerPage?: number;
    colorPerPage?: number;
    isOpen?: boolean;
    contactPhone?: string;
    contactPhoneAlt?: string;
    contactEmail?: string;
    whatsappNumber?: string;
    payoutMethods?: any[];
  },
  isAdmin: boolean = false
) {
  // Verify ownership (or bypass if admin)
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');
  if (shop.ownerUserId !== ownerUserId && !isAdmin) {
    throw ApiError.forbidden('You do not own this shop');
  }

  // Validate pricing.
  //
  // The floor is the half that matters. `updateShopSchema` rejects a sub-50p
  // rate too, but the rupees-as-paise bug is a *unit* error and its entry path
  // is that the browser does the rupee→paise conversion — so the defence has to
  // hold for a caller that never went through the form. Below 50 paise a page
  // is a hundredth of a rupee, which no shop means; zero stays legal because a
  // free black-and-white tier is a real offer.
  if (data.bwPerPage !== undefined && !isUsablePageRate(data.bwPerPage)) {
    throw ApiError.badRequest(
      data.bwPerPage < 0
        ? 'B/W price per page cannot be negative'
        : pageRateFloorMessage('B/W')
    );
  }
  if (data.colorPerPage !== undefined && !isUsablePageRate(data.colorPerPage)) {
    throw ApiError.badRequest(
      data.colorPerPage < 0
        ? 'Color price per page cannot be negative'
        : pageRateFloorMessage('Colour')
    );
  }

  const { payoutMethods } = data;

  /**
   * The columns a settings update may write, named one by one.
   *
   * Deliberately not `...rest`. The controller builds its payload as
   * `{ ...req.body }`, and `validate` parses a request to reject bad input
   * without ever writing the parsed body back — so Zod's stripping of unknown
   * keys never reaches here and anything the caller sends is in scope. Every
   * field below is a real Shop column, which meant a shop owner could PATCH
   * their own shop with
   *
   *     { "isOpen": true, "ledgerBalance": 999999, "debtAmount": 0, "isApproved": true }
   *
   * and Prisma would write all four: credit themselves an arbitrary balance,
   * clear money they owed the platform, and approve their own shop past the
   * admin review that is supposed to gate it. The balance is withdrawable, so
   * that is a direct route from a settings form to a payout.
   *
   * An allowlist is the control rather than the schema, because it holds
   * wherever the call comes from and does not depend on middleware behaviour.
   * Balances move only through `ledger.service`, which is the single place that
   * takes the compare-and-swap on `financialVersion`; approval moves only
   * through `approveShop`.
   */
  const shopData = {
    ...(data.bwPerPage !== undefined ? { bwPerPage: data.bwPerPage } : {}),
    ...(data.colorPerPage !== undefined ? { colorPerPage: data.colorPerPage } : {}),
    ...(data.isOpen !== undefined ? { isOpen: data.isOpen } : {}),
    ...(data.contactPhone !== undefined ? { contactPhone: data.contactPhone } : {}),
    ...(data.contactPhoneAlt !== undefined ? { contactPhoneAlt: data.contactPhoneAlt } : {}),
    ...(data.contactEmail !== undefined ? { contactEmail: data.contactEmail } : {}),
    ...(data.whatsappNumber !== undefined ? { whatsappNumber: data.whatsappNumber } : {}),
  };

  if (payoutMethods !== undefined) {
    return prisma.$transaction(async (tx) => {
      const updatedShop = await tx.shop.update({
        where: { id: shopId },
        data: shopData,
        select: shopSelect,
      });

      await tx.payoutMethod.deleteMany({ where: { shopId } });
      
      if (payoutMethods.length > 0) {
        await tx.payoutMethod.createMany({
          data: payoutMethods.map((pm: any) => ({
            id: pm.id || undefined,
            shopId,
            type: pm.type,
            accountHolderName: pm.accountHolderName,
            accountNumber: pm.accountNumber,
            ifscCode: pm.ifscCode,
            bankName: pm.bankName,
            upiId: pm.upiId,
            isPrimary: pm.isPrimary,
            nickname: pm.nickname
          }))
        });
      }

      return updatedShop;
    });
  }

  return prisma.shop.update({
    where: { id: shopId },
    data: shopData,
    select: shopSelect,
  });
}

// ────────────────────────────────────────────────────────────
// ADMIN ACTIONS
// ────────────────────────────────────────────────────────────

/**
 * Admin approves a shop — makes it visible to students.
 */
export async function approveShop(shopId: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');
  if (shop.isApproved) throw ApiError.conflict('Shop is already approved');

  return prisma.shop.update({
    where: { id: shopId },
    data: { isApproved: true, isArchived: false, isRejected: false, rejectionReason: null },
    select: shopSelect,
  });
}

/**
 * Admin rejects a shop application.
 */
export async function rejectShop(shopId: string, rejectionReason?: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');

  return prisma.shop.update({
    where: { id: shopId },
    data: { isApproved: false, isRejected: true, isOpen: false, rejectionReason: rejectionReason || 'Your shop application has been rejected by admin.' },
    select: shopSelect,
  });
}

/**
 * Admin archives a shop — hides from students but keeps data.
 */
export async function archiveShop(shopId: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');

  return prisma.shop.update({
    where: { id: shopId },
    data: { isArchived: true, isOpen: false },
    select: shopSelect,
  });
}

/**
 * Admin unarchives a shop.
 */
export async function unarchiveShop(shopId: string) {
  return prisma.shop.update({
    where: { id: shopId },
    data: { isArchived: false },
    select: shopSelect,
  });
}

// ────────────────────────────────────────────────────────────
// AGGREGATE STATS
// ────────────────────────────────────────────────────────────

/**
 * Get or compute aggregate stats for a shop dashboard.
 */
export async function getShopAggregate(shopId: string, ownerUserId: string, isAdmin: boolean = false) {
  // Verify the shop exists and the user owns it (or is admin)
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw ApiError.notFound('Shop not found');
  if (shop.ownerUserId !== ownerUserId && !isAdmin) {
    throw ApiError.forbidden('You do not own this shop');
  }

  // Compute aggregate from orders
  const [orderStats, payoutStats, pendingPayoutCount, pendingPayoutValue] = await Promise.all([
    prisma.order.groupBy({
      by: ['status'],
      where: { shopId },
      _count: true,
      _sum: { totalPrice: true, baseFee: true, pageCost: true },
    }),
    /**
     * Everything that has actually left, whoever has acknowledged it.
     *
     * This counted `PAID` alone, so money stopped being "paid out" the moment
     * a shop confirmed receiving it — the one event that proves it arrived.
     * A shop with one confirmed payout saw "Paid Out ₹0", and because
     * `lifetimeNetEarned` is built from this number, their lifetime earnings
     * read ₹0 as well.
     *
     * `IN_TRANSIT` is here for rows created before approve and mark-sent were
     * collapsed into one step. The same three statuses are what the dashboard,
     * `AdminShopCard` and `AdminPayoutModal` already treat as sent, and this
     * was the only place that disagreed.
     */
    prisma.payout.aggregate({
      where: { shopId, status: { in: ['PAID', 'IN_TRANSIT', 'CONFIRMED'] } },
      _sum: { amount: true },
    }),
    /**
     * Payouts still waiting on an admin — which is what `pendingPayoutCount`
     * has always claimed to hold.
     *
     * It was previously the `_count` of the aggregate above, so the field named
     * "pending" reported the number of payouts that had already been *sent*.
     * The two are near enough opposites: a shop with every payout settled and
     * nothing outstanding read as its busiest.
     */
    prisma.payout.count({ where: { shopId, status: 'PENDING' } }),
    /**
     * The *value* of what is still waiting on an admin, to go with the count
     * beside it.
     *
     * This field held `shop.pendingBalance` — the clearing balance, which is
     * money earned inside the settlement window and has nothing to do with
     * payouts at all. Read next to `pendingPayoutCount` it produced "₹X across N
     * pending payouts" from two unrelated numbers. Nothing renders it yet, which
     * is exactly why it is worth correcting before something starts trusting the
     * name.
     */
    prisma.payout.aggregate({
      where: { shopId, status: 'PENDING' },
      _sum: { amount: true },
    }),
  ]);

  /**
   * What this shop has actually given back, net of reversals.
   *
   * Revenue used to be handled by excluding REFUNDED orders wholesale, which is
   * wrong in both directions once partial refunds exist: a ₹100 refund on a ₹500
   * order removed all ₹500 from revenue, and a refund that the gateway later
   * *failed* — reversed in the ledger, order returned to COMPLETED — removed
   * nothing even while the deduction stood.
   *
   * The ledger already holds the answer to the paisa, so revenue is now the page
   * cost of every order that reached the shop, minus what the ledger says was
   * handed back. The two figures come from the same place the shop's balance
   * does, so the dashboard and the books can no longer disagree.
   *
   * Reversals are matched on the `:reversal` key rather than on the ADJUSTMENT
   * type, for the same reason `shopShareOfRefund` does it: ADJUSTMENT is a
   * general-purpose correction, and the first unrelated one would otherwise
   * inflate revenue.
   */
  const [deducted, reversed] = await Promise.all([
    prisma.ledgerEntry.aggregate({
      where: { shopId, type: 'REFUND_DEDUCTION', status: { not: 'VOID' } },
      _sum: { amount: true },
    }),
    prisma.ledgerEntry.aggregate({
      where: {
        shopId,
        type: 'ADJUSTMENT',
        status: { not: 'VOID' },
        eventId: { endsWith: ':reversal' },
      },
      _sum: { amount: true },
    }),
  ]);

  const refundedToStudents = Math.max(
    0,
    (deducted._sum.amount ?? 0) - (reversed._sum.amount ?? 0)
  );

  const validOrderStatuses = ['PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP', 'COMPLETED', 'REFUNDED'];
  // REFUNDED is included now, and the refund is subtracted from the total below
  // instead. Excluding the order discarded its whole page cost however little
  // came back, and could not see a partial refund on an order that is still
  // COMPLETED at all. Netting is the only treatment that is right for both.
  const revenueStatuses = ['PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP', 'COMPLETED', 'REFUNDED'];
  const activeStatuses = ['PENDING_APPROVAL', 'PRINTING', 'READY_FOR_PICKUP'];

  let totalOrders = 0;
  let activeOrders = 0;
  let completedOrders = 0;
  let totalRevenue = 0;
  let totalBaseFees = 0;

  for (const stat of orderStats) {
    if (validOrderStatuses.includes(stat.status)) {
      totalOrders += stat._count;
    }

    if (revenueStatuses.includes(stat.status)) {
      // `pageCost`, not `totalPrice`. The shop earns the page cost; `baseFee` is
      // the platform's commission and is reported separately as `totalBaseFees`.
      //
      // This summed `totalPrice`, which already contains `baseFee` — and
      // AdminDashboard then computes `shopEarnings + platformFees` from these
      // two figures, so every base fee was counted twice in the platform-wide
      // revenue total. The dashboard's own fallback path (when an aggregate is
      // missing) sums `pageCost` for earnings and `baseFee` for fees, which is
      // what this always meant to return.
      totalRevenue += stat._sum.pageCost || 0;
      totalBaseFees += stat._sum.baseFee || 0;
    }

    if (stat.status === 'COMPLETED') {
      completedOrders = stat._count;
    }
    if (activeStatuses.includes(stat.status)) {
      activeOrders += stat._count;
    }
  }

  // Never negative: a refund can exceed what an order earned only when a
  // reversal has been missed, and a negative headline figure on a dashboard
  // reads as a bug in the dashboard rather than as one in the ledger.
  totalRevenue = Math.max(0, totalRevenue - refundedToStudents);

  // Upsert aggregate for caching
  const aggregate = await prisma.shopAggregate.upsert({
    where: { shopId },
    create: {
      shopId,
      totalOrders,
      activeOrders,
      completedOrders,
      totalRevenue,
      totalBaseFees,
      totalPaidOut: payoutStats._sum.amount || 0,
      pendingPayouts: pendingPayoutValue._sum.amount || 0,
      pendingPayoutCount,
    },
    update: {
      totalOrders,
      activeOrders,
      completedOrders,
      totalRevenue,
      totalBaseFees,
      totalPaidOut: payoutStats._sum.amount || 0,
      pendingPayouts: pendingPayoutValue._sum.amount || 0,
      pendingPayoutCount,
    },
  });

  return aggregate;
}
