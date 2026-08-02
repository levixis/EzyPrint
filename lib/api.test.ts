import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Retrying, and — more importantly — not retrying.
 *
 * A backend that is mid-deploy or cold-booting rejects every in-flight request,
 * so a dashboard loses all its panels at once and a login drops to the sign-in
 * screen. One retry rides through that.
 *
 * The risk is retrying the wrong thing. A network failure says only that we
 * never heard back, not that nothing happened: replaying a POST is how one
 * payout request becomes two, and how a refresh whose rotation already landed
 * presents a spent token, trips reuse detection and revokes every session.
 */

const NETWORK_FAIL = () => Promise.reject(new TypeError('Failed to fetch'));
const ok = (data: unknown = { ok: true }) =>
  Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ success: true, data }),
  } as unknown as Response);

let api: typeof import('./api');

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  api = await import('./api');
});
afterEach(() => { vi.useRealTimers(); });

/** Runs a call to completion while fast-forwarding the retry delay. */
const settle = async <T,>(p: Promise<T>) => {
  const result = p.catch((e) => ({ __err: e }) as never);
  await vi.advanceTimersByTimeAsync(2000);
  return result;
};

describe('Reads ride through a blip', () => {
  test('a GET that fails on the network is retried once and succeeds', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(NETWORK_FAIL).mockImplementationOnce(() => ok({ v: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await settle(api.get('/orders'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ v: 1 });
  });

  test('it retries once, not forever', async () => {
    const fetchMock = vi.fn().mockImplementation(NETWORK_FAIL);
    vi.stubGlobal('fetch', fetchMock);

    const result = await settle(api.get('/orders')) as { __err: Error };

    // A backend down for a minute must not turn into an unbounded loop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.__err).toBeInstanceOf(TypeError);
  });
});

describe('Writes are never replayed', () => {
  test('a POST that fails on the network is not retried', async () => {
    const fetchMock = vi.fn().mockImplementation(NETWORK_FAIL);
    vi.stubGlobal('fetch', fetchMock);

    await settle(api.post('/payouts/request', { amount: 500 }));

    // Two payout requests from one tap is worse than a visible failure.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('PATCH and DELETE are not retried either', async () => {
    for (const call of [() => api.patch('/orders/1', {}), () => api.del('/refunds/1')]) {
      const fetchMock = vi.fn().mockImplementation(NETWORK_FAIL);
      vi.stubGlobal('fetch', fetchMock);
      await settle(call());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});

describe('A real answer is never retried', () => {
  test('a 500 is returned as an error, not retried', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: false, error: 'Internal server error' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await settle(api.get('/orders')) as { __err: Error };

    // The server answered. Asking again gets the same answer and hides it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.__err.message).toContain('Internal server error');
  });
});
