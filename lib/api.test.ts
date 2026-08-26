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

/**
 * Downloads used to be the one request that went straight to `fetch`.
 *
 * That gave `downloadBlob` no deadline, no retry and — the part that actually
 * bit — no 401 → refresh. Access tokens last 15 minutes, so a shop opening a
 * student's file after a quiet spell got a hard failure while every other call
 * on the same screen refreshed and carried on.
 *
 * It now goes through `apiFetch`, so what is worth pinning is that it still
 * comes back as a Blob. The endpoint types its response from the file's
 * extension — docx, pptx, xlsx and images all arrive alongside pdf — and
 * `apiFetch`'s content-type sniffing only recognises pdf and octet-stream, so
 * anything else would be read as text and corrupted.
 */
describe('Downloads are ordinary requests', () => {
  const blob = (type: string) => {
    const body = new Blob(['%PDF-1.4'], { type });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => type },
      blob: async () => body,
      text: async () => '%PDF-1.4',
      json: async () => ({}),
    } as unknown as Response);
  };

  test('a docx comes back as a Blob, not as text', async () => {
    // The content type the sniffing does not recognise. Before the blob flag
    // this fell through to `res.text()`.
    const type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => blob(type)));

    const result = await settle(api.downloadBlob('/uploads/download/a.docx'));

    expect(result).toBeInstanceOf(Blob);
  });

  test('a pdf comes back as a Blob', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => blob('application/pdf')));

    expect(await settle(api.downloadBlob('/uploads/download/a.pdf'))).toBeInstanceOf(Blob);
  });

  test('a download that fails on the network is retried once', async () => {
    // It is a GET, so it earns the same one retry every other read gets.
    const fetchMock = vi.fn()
      .mockImplementationOnce(NETWORK_FAIL)
      .mockImplementationOnce(() => blob('application/pdf'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await settle(api.downloadBlob('/uploads/download/a.pdf'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toBeInstanceOf(Blob);
  });

  test('a download is sent with a deadline', async () => {
    // The original bug: `fetch` without a signal waits for ever, so a download
    // against a cold instance left the button spinning with no way back.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => blob('application/pdf')));

    await settle(api.downloadBlob('/uploads/download/a.pdf'));

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.signal).toBeDefined();
  });

  test('an expired token is refreshed and the download retried', async () => {
    // The reason this function was worth moving. Access tokens last 15
    // minutes; a shop opening a student's file after a quiet spell used to get
    // a bare 401 here while every other call on the same screen refreshed and
    // carried on.
    api.setTokens('expired-access', 'good-refresh');

    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: false, message: 'jwt expired' }),
      } as unknown as Response))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ data: { tokens: { accessToken: 'fresh', refreshToken: 'fresh-r' } } }),
      } as unknown as Response))
      .mockImplementationOnce(() => blob('application/pdf'));

    vi.stubGlobal('fetch', fetchMock);

    const result = await settle(api.downloadBlob('/uploads/download/a.pdf'));

    expect(result).toBeInstanceOf(Blob);

    const paths = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(paths[1]).toContain('/auth/refresh');
    // Replayed with the new token, not the dead one.
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer fresh');
  });

  test('an error response is thrown, not handed back as a file', async () => {
    // A JSON error body returned as a Blob is a "download" of the error text.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve({
      ok: false,
      status: 404,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: false, message: 'This file is no longer here' }),
    } as unknown as Response)));

    const result = await settle(api.downloadBlob('/uploads/download/gone.pdf')) as unknown as { __err: Error };

    expect(result.__err).toBeInstanceOf(Error);
    expect(result.__err.message).toContain('no longer here');
  });
});

/**
 * The refresh call is the one that must never hang.
 *
 * `refreshTokenOnce` dedupes on a module-level `refreshPromise`, cleared in a
 * `.finally()`. A fetch that never settles never reaches it, so the promise is
 * never cleared and every subsequent 401 anywhere in the app awaits the same
 * dead promise — no error, no recovery, nothing on screen changing. A phone
 * moving between cells mid-POST is enough to trigger it.
 */
describe('The token refresh has a deadline', () => {
  test('the refresh POST is sent with an abort signal', async () => {
    api.setTokens('expired-access', 'good-refresh');

    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({
        ok: false, status: 401,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: false, message: 'jwt expired' }),
      } as unknown as Response))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ data: { tokens: { accessToken: 'f', refreshToken: 'fr' } } }),
      } as unknown as Response))
      .mockImplementationOnce(() => Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true, data: { v: 1 } }),
      } as unknown as Response));
    vi.stubGlobal('fetch', fetchMock);

    await settle(api.get('/orders'));

    const refreshCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/auth/refresh'));
    expect(refreshCall).toBeDefined();
    expect(refreshCall![1].signal).toBeDefined();
  });

  test('a refresh that never answers settles, and releases the dedup promise', async () => {
    // The regression in its clearest form. Two separate properties matter:
    // the call that triggered it must stop pending, and `refreshPromise` must
    // be cleared — otherwise every later 401 awaits a promise that will never
    // settle, and the app simply stops updating with nothing on screen to say
    // so. If the promise were still held, the second half of this test would
    // hang rather than fail.
    api.setTokens('expired-access', 'good-refresh');

    const unauthorized = () => Promise.resolve({
      ok: false, status: 401,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: false, message: 'jwt expired' }),
    } as unknown as Response);

    /** A refresh that answers only when its deadline aborts it. */
    const stalls = (_u: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });

    const fetchMock = vi.fn()
      .mockImplementationOnce(unauthorized)
      .mockImplementationOnce(stalls)
      .mockImplementation(unauthorized);
    vi.stubGlobal('fetch', fetchMock);

    const first = settle(api.get('/orders'));
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await first as { __err: Error };

    // It ended, rather than pending for ever.
    expect(result.__err).toBeInstanceOf(Error);

    // A stalled refresh clears the tokens, so signing back in is what a real
    // session does next. The point is that this is *possible* — a held
    // `refreshPromise` would swallow it.
    api.setTokens('expired-again', 'another-refresh');

    const second = settle(api.get('/notifications'));
    await vi.advanceTimersByTimeAsync(60_000);
    await second;

    const refreshes = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/auth/refresh'));
    expect(refreshes.length).toBe(2);
  });
});
