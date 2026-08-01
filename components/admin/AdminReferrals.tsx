import React, { useState, useEffect, useMemo } from 'react';
import { referralApi, ReferralCode } from '../../lib/queries';
import { Button } from '../common/Button';
import { Card } from '../common/Card';
import { Spinner } from '../common/Spinner';
import { formatDate } from '../../utils/datetime';

export type ReferralStatus = 'active' | 'used' | 'expired';

/**
 * One definition of a code's status, so the badge and the filter cannot
 * disagree about what the same row is.
 *
 * Read `usedAt` rather than `usedBy`: the latter is a foreign key that clears
 * when the shop owner's account is deleted, and such a code is still spent.
 */
export const referralStatus = (code: ReferralCode, now: Date = new Date()): ReferralStatus => {
  if (code.usedAt || code.usedBy) return 'used';
  if (code.expiresAt && new Date(code.expiresAt) < now) return 'expired';
  return 'active';
};

const STATUS_STYLES: Record<ReferralStatus, string> = {
  active: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  used: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  expired: 'bg-gray-100 text-gray-800 dark:bg-zinc-700 dark:text-gray-300',
};

const STATUS_LABELS: Record<ReferralStatus, string> = {
  active: 'Active',
  used: 'Used',
  expired: 'Expired',
};

type Filter = ReferralStatus | 'all';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'active', label: 'Active' },
  { key: 'used', label: 'Used' },
  { key: 'expired', label: 'Expired' },
  { key: 'all', label: 'All' },
];

/**
 * Who a spent code let in.
 *
 * The relation is optional because the account may since have been deleted —
 * the code survives that on purpose, so the row is labelled rather than left
 * looking unused.
 */
const usedByLabel = (code: ReferralCode): string => {
  if (!code.usedAt && !code.usedBy) return '—';
  const shop = code.user?.shop?.name;
  const person = code.user?.name || code.user?.email;
  if (shop && person) return `${shop} (${person})`;
  return shop || person || 'Deleted account';
};

const AdminReferrals: React.FC = () => {
  const [codes, setCodes] = useState<ReferralCode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  // Active by default: a used code is a record to look up, not something an
  // admin needs in front of them while handing out new ones.
  const [filter, setFilter] = useState<Filter>('active');

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (code: string, id: string) => {
    navigator.clipboard.writeText(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const fetchCodes = async () => {
    try {
      setIsLoading(true);
      const data = await referralApi.list();
      setCodes(data);
    } catch (err) {
      setError('Failed to load referral codes.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchCodes();
  }, []);

  const handleGenerate = async () => {
    try {
      setIsGenerating(true);
      setError('');
      await referralApi.create(7); // default 7 days valid
      await fetchCodes();
    } catch (err) {
      setError('Failed to generate referral code.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this referral code?')) return;
    try {
      await referralApi.delete(id);
      await fetchCodes();
    } catch (err) {
      setError('Failed to delete referral code. It may have already been used.');
    }
  };

  const counts = useMemo(() => {
    const now = new Date();
    return codes.reduce(
      (acc, code) => {
        acc[referralStatus(code, now)]++;
        acc.all++;
        return acc;
      },
      { active: 0, used: 0, expired: 0, all: 0 } as Record<Filter, number>
    );
  }, [codes]);

  const visible = useMemo(() => {
    if (filter === 'all') return codes;
    const now = new Date();
    return codes.filter((code) => referralStatus(code, now) === filter);
  }, [codes, filter]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-xl font-bold text-gray-900 dark:text-white">Referral Codes</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage referral codes for Shop Owner registration.</p>
        </div>
        <Button onClick={handleGenerate} disabled={isGenerating} variant="primary" size="md">
          {isGenerating ? 'Generating...' : '+ Generate New Code'}
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {!isLoading && codes.length > 0 && (
        <div role="tablist" aria-label="Filter referral codes" className="flex flex-wrap gap-2">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filter === key
                  ? 'bg-brand-primary text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-zinc-800 dark:text-gray-300 dark:hover:bg-zinc-700'
              }`}
            >
              {label}
              <span className={`ml-1.5 ${filter === key ? 'text-white/70' : 'text-gray-400 dark:text-gray-500'}`}>
                {counts[key]}
              </span>
            </button>
          ))}
        </div>
      )}

      <Card>
        {isLoading ? (
          <div className="flex justify-center p-8"><Spinner /></div>
        ) : codes.length === 0 ? (
          <div className="text-center p-8 text-gray-500 dark:text-gray-400">
            No referral codes found. Generate one to get started.
          </div>
        ) : visible.length === 0 ? (
          <div className="text-center p-8 text-gray-500 dark:text-gray-400">
            {/* Unreachable for 'all' — if any code exists, 'all' shows it. */}
            No {filter === 'all' ? '' : `${STATUS_LABELS[filter].toLowerCase()} `}codes.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-gray-500 uppercase bg-gray-50 dark:bg-zinc-800 dark:text-gray-400">
                <tr>
                  <th className="px-6 py-3 rounded-tl-lg">Code</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Used By</th>
                  <th className="px-6 py-3">Issued By</th>
                  <th className="px-6 py-3">Created At</th>
                  <th className="px-6 py-3">Expires At</th>
                  <th className="px-6 py-3 rounded-tr-lg">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-zinc-800">
                {visible.map((code) => (
                  <tr key={code.id} className="hover:bg-gray-50 dark:hover:bg-zinc-800/50">
                    <td className="px-6 py-4 font-mono font-medium text-gray-900 dark:text-white flex items-center space-x-2">
                      <span>{code.code}</span>
                      <button
                        onClick={() => handleCopy(code.code, code.id)}
                        className="text-gray-400 hover:text-brand-primary focus:outline-none transition-colors"
                        title="Copy code"
                      >
                        {copiedId === code.id ? (
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-green-500">
                            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                          </svg>
                        )}
                      </button>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          STATUS_STYLES[referralStatus(code)]
                        }`}
                      >
                        {STATUS_LABELS[referralStatus(code)]}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400">
                      {usedByLabel(code)}
                    </td>
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400">
                      {code.creator?.name || code.creator?.email || 'Deleted account'}
                    </td>
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400">
                      {formatDate(code.createdAt)}
                    </td>
                    <td className="px-6 py-4 text-gray-500 dark:text-gray-400">
                      {code.expiresAt ? formatDate(code.expiresAt) : 'Never'}
                    </td>
                    <td className="px-6 py-4">
                      {referralStatus(code) !== 'used' && (
                        <button
                          onClick={() => handleDelete(code.id)}
                          className="text-red-600 hover:text-red-900 dark:text-red-400 dark:hover:text-red-300 text-xs font-medium"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default AdminReferrals;

