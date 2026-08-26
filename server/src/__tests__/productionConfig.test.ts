/**
 * What the server refuses to start with in production.
 *
 * `assertProductionConfig` exists for settings that are present, valid-looking
 * and wrong — the class where the process boots cleanly and the damage is
 * silent. That makes it exactly the kind of code that rots unnoticed, because
 * nothing exercises it until a real deploy.
 *
 * The CORS case is the one that prompted this file. `CORS_ORIGINS=*` reads as
 * "allow everything" and does the opposite: the `cors` package compares array
 * entries with `===`, so the literal '*' matches no origin, every browser
 * request is answered without an `Access-Control-Allow-Origin` header, and the
 * web app fails with "Failed to fetch". The Android build keeps working the
 * whole time — it is allowed separately by NATIVE_APP_ORIGINS — so the symptom
 * points away from the cause.
 */

/** The `requireSecret` values, which throw at import time under NODE_ENV=production. */
const SECRETS = {
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  GOOGLE_CLIENT_IDS: '123-abc.apps.googleusercontent.com',
  RAZORPAY_KEY_SECRET: 'rzp-secret',
  RAZORPAY_WEBHOOK_SECRET: 'wh-secret',
  PUSHER_APP_ID: '1',
  PUSHER_KEY: 'pk',
  PUSHER_SECRET: 'ps',
};

/** Everything `assertProductionConfig` checks, set to a passing value. */
const VALID = {
  ...SECRETS,
  NODE_ENV: 'production',
  STORAGE_MODE: 's3',
  S3_BUCKET: 'ezyprint',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_ACCESS_KEY: 'ak',
  S3_SECRET_KEY: 'sk',
  RAZORPAY_KEY_ID: 'rzp_live_abc123',
  RESEND_API_KEY: 're_abc123',
  EMAIL_FROM: 'EzyPrint <noreply@ezyprint.co.in>',
  ALERT_EMAIL: 'ops@ezyprint.co.in',
  CORS_ORIGINS: 'https://ezyprint.co.in',
};

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

/**
 * Load a fresh copy of the config under the given environment and run the
 * assertion, returning the thrown message or null.
 *
 * `env.ts` reads NODE_ENV at module scope, so the module registry has to be
 * reset for each case rather than the value poked afterwards.
 */
function checkWith(overrides: Record<string, string | undefined>): string | null {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, ...VALID, ...overrides } as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
  }

  try {
    const { assertProductionConfig } = require('../config/env');
    assertProductionConfig();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('CORS_ORIGINS', () => {
  test('a wildcard is refused, because it allows nothing rather than everything', () => {
    const problem = checkWith({ CORS_ORIGINS: '*' });
    expect(problem).toContain('CORS_ORIGINS');
    expect(problem).toContain('literally');
  });

  test('a wildcard mixed in with real origins is still refused', () => {
    // The entry does not become a wildcard by keeping better company, and a
    // list that looks partly right is the easiest version to skim past.
    const problem = checkWith({ CORS_ORIGINS: 'https://ezyprint.co.in,*' });
    expect(problem).toContain('CORS_ORIGINS');
  });

  test('the localhost default — an unset variable — is refused', () => {
    const problem = checkWith({ CORS_ORIGINS: undefined });
    expect(problem).toContain('CORS_ORIGINS');
    expect(problem).toContain('localhost');
  });

  test('real origins pass', () => {
    expect(checkWith({ CORS_ORIGINS: 'https://ezyprint.co.in,https://www.ezyprint.co.in' })).toBeNull();
  });
});

describe('The rest of the production gate still holds', () => {
  test('a fully valid configuration starts', () => {
    // Guards the checks against becoming over-eager: a green deploy must stay
    // green, or the next person routes around the whole function.
    expect(checkWith({})).toBeNull();
  });

  test('a test Razorpay key is refused', () => {
    expect(checkWith({ RAZORPAY_KEY_ID: 'rzp_test_abc123' })).toContain('TEST key');
  });

  test('ephemeral local storage is refused', () => {
    expect(checkWith({ STORAGE_MODE: 'local' })).toContain('STORAGE_MODE');
  });

  test("Resend's shared testing sender is refused", () => {
    expect(checkWith({ EMAIL_FROM: 'onboarding@resend.dev' })).toContain('resend.dev');
  });

  test('nothing is checked outside production', () => {
    // The same broken settings, in development. Every check in the function is
    // about a live deployment, and applying them locally would make a laptop
    // unable to run the server at all.
    expect(checkWith({ NODE_ENV: 'development', CORS_ORIGINS: '*', STORAGE_MODE: 'local' })).toBeNull();
  });
});
