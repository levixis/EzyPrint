/**
 * Unit Tests — which order states release their files.
 *
 * A print job is transient: once the order is finished nobody needs the bytes
 * again, and holding scanned IDs and coursework indefinitely is liability with
 * no upside. But releasing them one state too early strands a student who has
 * uploaded and not yet paid.
 */

import { isTerminalForFiles } from '../services/cleanup.service';

describe('File retention states', () => {
  test('finished orders release their files', () => {
    expect(isTerminalForFiles('COMPLETED')).toBe(true);
    expect(isTerminalForFiles('CANCELLED')).toBe(true);
    expect(isTerminalForFiles('REFUNDED')).toBe(true);
  });

  test('a failed payment keeps its files, because the order can still be retried', () => {
    // Deleting here would leave the student unable to pay for work they already
    // uploaded — they would have to start over.
    expect(isTerminalForFiles('PAYMENT_FAILED')).toBe(false);
  });

  test('files survive every stage the shop still needs them for', () => {
    expect(isTerminalForFiles('PENDING_PAYMENT')).toBe(false);
    expect(isTerminalForFiles('PENDING_APPROVAL')).toBe(false);
    expect(isTerminalForFiles('PRINTING')).toBe(false);
    // Not yet collected — the shop may still need to reprint.
    expect(isTerminalForFiles('READY_FOR_PICKUP')).toBe(false);
  });
});

/**
 * Deleting on completion is right for the ordinary case. It is wrong while a
 * student is claiming the wrong thing was printed, because the file is the only
 * evidence of what was actually sent — destroying it reduces the dispute to one
 * person's word against another's.
 */
describe('Disputed orders keep their files', () => {
  const { UNSETTLED_REFUND_STATUSES } = require('../services/cleanup.service');

  test('every refund state before settlement counts as open', () => {
    for (const status of ['PENDING_SHOP', 'APPROVED_BY_SHOP', 'ESCALATED_TO_ADMIN', 'PROCESSING_REFUND']) {
      expect(UNSETTLED_REFUND_STATUSES).toContain(status);
    }
  });

  test('a refund Razorpay failed still counts as open', () => {
    // The request looks finished, but an admin has to retry the transfer, so
    // the claim is live and the evidence must survive.
    expect(UNSETTLED_REFUND_STATUSES).toContain('REFUND_FAILED');
  });

  test('settled outcomes release the files', () => {
    for (const status of ['RESOLVED_REFUNDED', 'REFUND_SETTLED_OFFLINE', 'RESOLVED_DENIED']) {
      expect(UNSETTLED_REFUND_STATUSES).not.toContain(status);
    }
  });
});
