import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  systemApi,
  type HealthReport,
  type HealthCheck,
  type SystemEvent,
  type RemediationEntry,
  type PermittedRemediation,
} from '../../lib/queries';
import { Button } from '../common/Button';
import { Card } from '../common/Card';
import { Spinner } from '../common/Spinner';
import { formatDateTime } from '../../utils/datetime';

/**
 * System Health — the pull half of the monitoring system.
 *
 * Email and push are what interrupt you; this is what you open once they have.
 * It answers three questions in the order an operator actually asks them:
 * what is broken right now, what has been going wrong lately, and what did the
 * watchdog already do about it without asking.
 *
 * The third section matters more than it looks. A process that repairs
 * production unattended is only tolerable if what it did is visible afterwards,
 * so the audit trail is on screen next to the health, not buried in a log.
 */

const STATUS_STYLES: Record<HealthCheck['status'], string> = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  fail: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  skipped: 'bg-gray-100 text-gray-600 dark:bg-zinc-700 dark:text-gray-400',
};

const STATUS_DOT: Record<HealthCheck['status'], string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  fail: 'bg-red-500',
  skipped: 'bg-gray-400',
};

const SEVERITY_STYLES: Record<SystemEvent['severity'], string> = {
  INFO: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  WARNING: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  ERROR: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
  CRITICAL: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
};

const OUTCOME_STYLES: Record<RemediationEntry['outcome'], string> = {
  SUCCEEDED: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  SKIPPED: 'bg-gray-100 text-gray-600 dark:bg-zinc-700 dark:text-gray-400',
  FAILED: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  BLOCKED: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
};

/** Human-readable check names — the ids are stable keys, not labels. */
const CHECK_LABELS: Record<string, string> = {
  database: 'Database',
  scheduler: 'Background jobs',
  stranded_payments: 'Stranded payments',
  stranded_refunds: 'Stuck refunds',
  realtime_outbox: 'Real-time delivery',
  settlement_backlog: 'Settlement',
  webhooks: 'Razorpay webhooks',
  email: 'Email delivery',
  errors: 'Error rate',
  storage: 'File storage (R2)',
  payment_gateway: 'Razorpay gateway',
};

const label = (name: string) => CHECK_LABELS[name] ?? name.replace(/_/g, ' ');

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const SystemHealth: React.FC = () => {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [history, setHistory] = useState<RemediationEntry[]>([]);
  const [permitted, setPermitted] = useState<PermittedRemediation[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow response from an earlier poll landing after a newer
  // one and reverting the panel to stale data — the same race that has bitten
  // this codebase before.
  const requestSeq = useRef(0);

  const load = useCallback(async (deep = false) => {
    const seq = ++requestSeq.current;
    try {
      const [healthResult, eventsResult, remediationResult] = await Promise.all([
        systemApi.health(deep),
        systemApi.events(),
        systemApi.remediations(),
      ]);

      if (seq !== requestSeq.current) return;

      setReport(healthResult);
      setEvents(eventsResult);
      setHistory(remediationResult.history);
      setPermitted(remediationResult.permitted);
      setError(null);
    } catch (loadError) {
      if (seq !== requestSeq.current) return;
      // A failure here usually means the API itself is unreachable, which is
      // information rather than an inconvenience — say so plainly.
      setError(loadError instanceof Error ? loadError.message : 'Could not reach the API.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // 30s: fast enough to watch an incident develop, slow enough that leaving
    // the tab open all day is not a meaningful load on Neon.
    const timer = setInterval(() => load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const runCheckNow = async () => {
    setRunning(true);
    try {
      await systemApi.runCheck();
      await load(true);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Check failed to run.');
    } finally {
      setRunning(false);
    }
  };

  const resolve = async (id: string) => {
    // Optimistic: resolving is reversible in the sense that matters — a new
    // occurrence reopens the event on its own.
    setEvents((current) => current.filter((event) => event.id !== id));
    try {
      await systemApi.resolveEvent(id);
    } catch {
      await load();
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  const failing = report?.checks.filter((check) => check.status === 'fail') ?? [];
  const warning = report?.checks.filter((check) => check.status === 'warn') ?? [];
  const healthy = report?.checks.filter((check) => check.status === 'ok' || check.status === 'skipped') ?? [];

  const overall = report?.status ?? 'down';
  const overallStyles =
    overall === 'ok'
      ? 'from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 border-green-200/50 dark:border-green-800/30'
      : overall === 'degraded'
        ? 'from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 border-amber-200/50 dark:border-amber-800/30'
        : 'from-red-50 to-rose-50 dark:from-red-900/20 dark:to-rose-900/20 border-red-200/50 dark:border-red-800/30';

  return (
    <div className="space-y-6">
      {/* ── Overall status ── */}
      <div className={`admin-card bg-gradient-to-br ${overallStyles} rounded-xl p-5 border`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span
              className={`w-3 h-3 rounded-full ${
                overall === 'ok' ? 'bg-green-500' : overall === 'degraded' ? 'bg-amber-500' : 'bg-red-500'
              } ${overall !== 'ok' ? 'animate-pulse' : ''}`}
            />
            <div>
              <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                {overall === 'ok'
                  ? 'All systems operational'
                  : overall === 'degraded'
                    ? `${failing.length} system${failing.length === 1 ? '' : 's'} failing`
                    : 'Database unreachable'}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {report ? `${report.environment} · up ${formatUptime(report.uptimeSeconds)} · checked ${formatDateTime(report.checkedAt)}` : ''}
              </p>
            </div>
          </div>

          <Button onClick={runCheckNow} disabled={running} variant="secondary">
            {running ? 'Checking…' : 'Run full check'}
          </Button>
        </div>

        {error && (
          <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>
        )}
      </div>

      {/* ── Checks ── */}
      <Card>
        <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Checks</h4>
        <div className="space-y-2">
          {[...failing, ...warning, ...healthy].map((check) => (
            <div
              key={check.name}
              className="flex items-start gap-3 p-3 rounded-lg bg-gray-50 dark:bg-zinc-800/50"
            >
              <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[check.status]}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-gray-900 dark:text-white capitalize">
                    {label(check.name)}
                  </span>
                  <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase ${STATUS_STYLES[check.status]}`}>
                    {check.status}
                  </span>
                  {typeof check.latencyMs === 'number' && (
                    <span className="text-xs text-gray-400">{check.latencyMs}ms</span>
                  )}
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5 break-words">
                  {check.summary}
                </p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-4">
          File storage and the payment gateway are only probed by “Run full check” — they are
          external calls, and polling them every 30 seconds would be a load on someone else's
          service for no added signal.
        </p>
      </Card>

      {/* ── Open errors ── */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
            Open errors {events.length > 0 && <span className="text-gray-400">({events.length})</span>}
          </h4>
        </div>

        {events.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
            Nothing unresolved. Errors are grouped by fault, not by occurrence — one bug hit a
            thousand times is one row with a count of 1000.
          </p>
        ) : (
          <div className="space-y-2">
            {events.map((event) => (
              <div key={event.id} className="p-3 rounded-lg bg-gray-50 dark:bg-zinc-800/50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${SEVERITY_STYLES[event.severity]}`}>
                        {event.severity}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">{event.source}</span>
                      {event.count > 1 && (
                        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                          ×{event.count}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-900 dark:text-white mt-1 break-words">
                      {event.message}
                    </p>
                    {event.lastSeenAt && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        last seen {formatDateTime(event.lastSeenAt)}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => resolve(event.id)}
                    className="shrink-0 text-xs font-medium text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white px-2 py-1 rounded transition-colors"
                  >
                    Resolve
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── Watchdog ── */}
      <Card>
        <h4 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
          Automatic recovery
        </h4>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          The watchdog may only re-run work the system had already decided to do and failed to
          finish. It cannot originate a payment, an earning or a refund, and it never deletes
          anything.
        </p>

        <div className="grid gap-2 sm:grid-cols-3 mb-5">
          {permitted.map((remediation) => (
            <div
              key={remediation.action}
              className="p-3 rounded-lg border border-gray-200 dark:border-zinc-700 bg-gray-50/50 dark:bg-zinc-800/30"
            >
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                {remediation.action}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {remediation.description}
              </p>
            </div>
          ))}
        </div>

        <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
          Recent actions
        </h5>
        {history.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-3 text-center">
            The watchdog has not needed to do anything.
          </p>
        ) : (
          <div className="space-y-1.5">
            {history.slice(0, 15).map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 text-sm p-2 rounded bg-gray-50 dark:bg-zinc-800/50"
              >
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0 ${OUTCOME_STYLES[entry.outcome]}`}>
                  {entry.outcome}
                </span>
                <span className="font-medium text-gray-900 dark:text-white truncate">
                  {entry.action}
                </span>
                <span className="text-xs text-gray-400 ml-auto shrink-0">
                  {entry.createdAt ? formatDateTime(entry.createdAt) : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

export default SystemHealth;
