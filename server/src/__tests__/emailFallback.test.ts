/**
 * Email transport selection and fallback.
 *
 * Render blocks outbound SMTP on free web services, so nodemailer cannot
 * deliver from there whatever the Gmail credentials say — and ours are valid,
 * they authenticate from anywhere that is not Render. That took out every OTP,
 * and OTP gates every payout.
 */

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => mockSendMail(...a) }) },
}));

const ORIGINAL = { ...process.env };

const load = async (envOverrides: Record<string, string>) => {
  jest.resetModules();
  process.env = { ...ORIGINAL, GMAIL_USER: '', GMAIL_APP_PASSWORD: '', RESEND_API_KEY: '', ...envOverrides };
  return import('../services/email.service');
};

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '' }) as never;
});
afterAll(() => { process.env = ORIGINAL; });

const send = (mod: { sendOTPEmail: (a: string, b: string, c?: string) => Promise<void> }) =>
  mod.sendOTPEmail('admin@ezyprint.in', '123456', 'payout_x');

describe('Choosing a transport', () => {
  test('HTTP is preferred when a key is present, and SMTP is not attempted', async () => {
    // Order matters: SMTP on a blocked host does not fail fast, it fails at the
    // connection timeout. Trying it first would add ten seconds to every email
    // while an admin waits on the dialog.
    const mod = await load({ RESEND_API_KEY: 'k', GMAIL_USER: 'a@b.c', GMAIL_APP_PASSWORD: 'p' });
    await send(mod);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('SMTP is used when no HTTP key is configured', async () => {
    const mod = await load({ GMAIL_USER: 'a@b.c', GMAIL_APP_PASSWORD: 'p' });
    await send(mod);

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('no transport configured is an error that says what to set', async () => {
    const mod = await load({});
    await expect(send(mod)).rejects.toThrow(/RESEND_API_KEY.*GMAIL_USER/s);
  });
});

describe('Falling back', () => {
  test('an HTTP failure falls through to SMTP', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }) as never;
    const mod = await load({ RESEND_API_KEY: 'k', GMAIL_USER: 'a@b.c', GMAIL_APP_PASSWORD: 'p' });

    await expect(send(mod)).resolves.toBeUndefined();
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test('an SMTP failure is survivable when HTTP is the only other option', async () => {
    mockSendMail.mockRejectedValue(new Error('ETIMEDOUT'));
    const mod = await load({ GMAIL_USER: 'a@b.c', GMAIL_APP_PASSWORD: 'p', RESEND_API_KEY: 'k' });

    await expect(send(mod)).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('when both fail the error names both reasons', async () => {
    // One of them is the real cause and the reader cannot tell which from a
    // single message, so both are reported rather than the last.
    global.fetch = jest.fn().mockRejectedValue(new Error('resend down')) as never;
    mockSendMail.mockRejectedValue(new Error('ETIMEDOUT'));
    const mod = await load({ RESEND_API_KEY: 'k', GMAIL_USER: 'a@b.c', GMAIL_APP_PASSWORD: 'p' });

    await expect(send(mod)).rejects.toThrow(/resend down.*ETIMEDOUT/s);
  });
});

describe('The message itself', () => {
  test('the code reaches the body over HTTP', async () => {
    const mod = await load({ RESEND_API_KEY: 'k' });
    await send(mod);

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.subject).toContain('123456');
    expect(body.text).toContain('123456');
    expect(body.to).toEqual(['admin@ezyprint.in']);
  });

  test('the action label is HTML-escaped in the body', async () => {
    // actionLabel comes off a request body and lands in an HTML sink.
    const mod = await load({ RESEND_API_KEY: 'k' });
    await mod.sendOTPEmail('a@b.c', '123456', '<img src=x onerror=alert(1)>');

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.html).not.toContain('<img');
    expect(body.html).toContain('&lt;img');
  });
});
