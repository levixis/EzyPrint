import React, { useState, useMemo } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { ShopProfile, DocumentOrder, ShopPayout, OrderStatus, PayoutStatus } from '../../types';
import { useAppContext } from '../../contexts/AppContext';

interface AdminPayoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  shop: ShopProfile;
  allOrders: DocumentOrder[];
  payouts: ShopPayout[];
}

const AdminPayoutModal: React.FC<AdminPayoutModalProps> = ({ isOpen, onClose, shop, allOrders, payouts }) => {
  const { createPayout } = useAppContext();
  const [amount, setAmount] = useState('');
  const [adminNote, setAdminNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [payoutMode, setPayoutMode] = useState<'all' | 'custom'>('all');

  const primaryUpi = shop.payoutMethods?.find(pm => pm.isPrimary && pm.type === 'UPI');
  const anyUpi = shop.payoutMethods?.find(pm => pm.type === 'UPI');
  const upiMethod = primaryUpi || anyUpi;

  // Calculate how much the shop has earned and what's still owed
  const financials = useMemo(() => {
    // Only count fully completed orders as earned revenue — in-progress orders shouldn't be payable
    const shopCompletedOrders = allOrders.filter(o => o.shopId === shop.id && o.status === OrderStatus.COMPLETED);
    const totalEarned = shopCompletedOrders.reduce((sum, o) => sum + o.priceDetails.pageCost, 0);
    const completedOrderCount = shopCompletedOrders.length;

    const totalAlreadyPaid = payouts
      .filter(p => p.shopId === shop.id && (p.status === PayoutStatus.CONFIRMED || p.status === PayoutStatus.PAID))
      .reduce((sum, p) => sum + p.amount, 0);

    const pendingPayoutAmount = payouts
      .filter(p => p.shopId === shop.id && p.status === PayoutStatus.PENDING)
      .reduce((sum, p) => sum + p.amount, 0);

    // pendingDue = what the shop has earned minus what's actually been paid out
    // NOTE: We do NOT subtract pendingPayoutAmount here — those are just requests,
    // not actual payments. The admin should still be able to pay the full due.
    const pendingDue = Math.max(0, totalEarned - totalAlreadyPaid);

    return { totalEarned, totalAlreadyPaid, pendingDue, completedOrderCount, pendingPayoutAmount };
  }, [allOrders, payouts, shop.id]);

  const effectiveAmount = payoutMode === 'all' ? financials.pendingDue : parseFloat(amount || '0');

  const handleSubmit = async () => {
    setError('');
    const parsedAmount = payoutMode === 'all' ? financials.pendingDue : parseFloat(amount);

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('Please enter a valid amount greater than ₹0.');
      return;
    }

    if (parsedAmount > financials.pendingDue) {
      setError(`Amount exceeds the pending due of ₹${financials.pendingDue.toFixed(2)}. You can only pay up to what the shop has earned.`);
      return;
    }

    setIsSubmitting(true);
    const result = await createPayout(shop.id, shop.name, parsedAmount, adminNote.trim());
    setIsSubmitting(false);

    if (result.success) {
      setAmount('');
      setAdminNote('');
      onClose();
    } else {
      setError(result.message || 'Failed to create payout.');
    }
  };

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/[^0-9.]/g, '');
    // Prevent entering more than pending due
    const numVal = parseFloat(val);
    if (!isNaN(numVal) && numVal > financials.pendingDue) {
      setAmount(financials.pendingDue.toFixed(2));
      return;
    }
    setAmount(val);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Send Payout to ${shop.name}`} size="md">
      <div className="space-y-5">
        {/* Earnings Summary */}
        <div className="bg-gradient-to-br from-gray-50 to-slate-50 dark:from-zinc-800/50 dark:to-zinc-800/80 rounded-xl p-4 border border-gray-200 dark:border-zinc-700">
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">Earnings Summary</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400">₹{financials.totalEarned.toFixed(2)}</p>
              <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">Total Earned</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-blue-600 dark:text-blue-400">₹{financials.totalAlreadyPaid.toFixed(2)}</p>
              <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">Already Paid</p>
            </div>
            <div className="text-center">
              <p className={`text-lg font-bold ${financials.pendingDue > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500'}`}>
                ₹{financials.pendingDue.toFixed(2)}
              </p>
              <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase">Pending Due</p>
            </div>
          </div>
          {financials.pendingPayoutAmount > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 text-center">
              ₹{financials.pendingPayoutAmount.toFixed(2)} in pending (unconfirmed) payouts
            </p>
          )}
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-2 text-center">
            From {financials.completedOrderCount} paid order{financials.completedOrderCount !== 1 ? 's' : ''}
          </p>
        </div>

        {/* No pending due warning */}
        {financials.pendingDue <= 0 && (
          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 rounded-lg p-3">
            <p className="text-sm text-amber-700 dark:text-amber-400 font-medium">
              ⚠️ No pending dues for this shop. All earnings have been paid out.
            </p>
          </div>
        )}

        {/* UPI Info */}
        <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800/50">
          <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider mb-2">Pay via UPI</p>
          {upiMethod ? (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-100 dark:bg-emerald-800/50 flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-emerald-600 dark:text-emerald-400">
                  <path d="M2.273 5.625A4.483 4.483 0 0 1 5.25 4.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 3H5.25a3 3 0 0 0-2.977 2.625ZM2.273 8.625A4.483 4.483 0 0 1 5.25 7.5h13.5c1.141 0 2.183.425 2.977 1.125A3 3 0 0 0 18.75 6H5.25a3 3 0 0 0-2.977 2.625ZM5.25 9a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h13.5a3 3 0 0 0 3-3v-6a3 3 0 0 0-3-3H15a.75.75 0 0 0-.75.75 2.25 2.25 0 0 1-4.5 0A.75.75 0 0 0 9 9H5.25Z" />
                </svg>
              </div>
              <div>
                <p className="text-lg font-bold text-gray-900 dark:text-white font-mono">{upiMethod.upiId}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{upiMethod.nickname || 'UPI'}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              ⚠️ No UPI method configured for this shop. Ask the shop owner to add one in their settings.
            </p>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800/50">{error}</p>
        )}

        {/* Payout Mode Toggle */}
        {financials.pendingDue > 0 && (
          <div className="space-y-4">
            <div className="flex gap-2 p-1 bg-gray-100 dark:bg-zinc-800 rounded-xl">
              <button
                onClick={() => { setPayoutMode('all'); setAmount(''); setError(''); }}
                className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-all duration-200 ${
                  payoutMode === 'all'
                    ? 'bg-white dark:bg-zinc-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Pay All (₹{financials.pendingDue.toFixed(2)})
              </button>
              <button
                onClick={() => { setPayoutMode('custom'); setError(''); }}
                className={`flex-1 py-2.5 px-4 rounded-lg text-sm font-medium transition-all duration-200 ${
                  payoutMode === 'custom'
                    ? 'bg-white dark:bg-zinc-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                Custom Amount
              </button>
            </div>

            {payoutMode === 'custom' && (
              <div>
                <Input
                  label={`Payout Amount (max ₹${financials.pendingDue.toFixed(2)})`}
                  id="payoutAmount"
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={handleAmountChange}
                  placeholder={`e.g., ${Math.min(500, financials.pendingDue).toFixed(2)}`}
                  leftIcon={<span className="text-gray-400 font-medium">₹</span>}
                />
                {/* Quick amount buttons */}
                <div className="flex gap-2 mt-2 flex-wrap">
                  {[0.25, 0.5, 0.75, 1].map(fraction => {
                    const quickAmount = parseFloat((financials.pendingDue * fraction).toFixed(2));
                    if (quickAmount <= 0) return null;
                    return (
                      <button
                        key={fraction}
                        onClick={() => setAmount(quickAmount.toFixed(2))}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-zinc-700 transition-colors border border-gray-200 dark:border-zinc-600"
                      >
                        {fraction === 1 ? 'All' : `${fraction * 100}%`} — ₹{quickAmount.toFixed(2)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <Input
          label="Note (optional)"
          id="payoutNote"
          type="text"
          value={adminNote}
          onChange={(e) => setAdminNote(e.target.value)}
          placeholder="e.g., Payment for orders from March 20-23"
        />

        <div className="flex justify-end space-x-3 pt-4 border-t border-gray-200 dark:border-zinc-700">
          <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={isSubmitting || financials.pendingDue <= 0 || effectiveAmount <= 0}
            className="!bg-gradient-to-r !from-emerald-500 !to-green-600 hover:!from-emerald-600 hover:!to-green-700"
          >
            {isSubmitting ? 'Sending...' : `Mark Payout as Paid — ₹${effectiveAmount.toFixed(2)}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default AdminPayoutModal;
