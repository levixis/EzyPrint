import nodemailer from 'nodemailer';
import { env } from '../config/env';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
      throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set to send emails.');
    }
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: env.GMAIL_USER,
        pass: env.GMAIL_APP_PASSWORD,
      },
      // Nodemailer's defaults are minutes long — two for a connection, ten for
      // a socket. The OTP request awaits this before it answers, so an SMTP
      // connection that stalls left the admin's "Sending OTP…" button spinning
      // with no error, and the request holding a worker the whole time.
      //
      // Ten seconds is far longer than Gmail needs when it is reachable, and
      // short enough that failure arrives while the admin is still looking at
      // the screen.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }
  return transporter;
}

/**
 * Escape a value for interpolation into an HTML email body.
 *
 * Email templates are built with template literals, so any value placed in one
 * lands in an HTML sink with no framework escaping it. `actionLabel` in
 * particular originates from a request body.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Send over HTTPS through Resend.
 *
 * Exists because Render blocks outbound traffic to SMTP ports 25, 465 and 587
 * on free web services (since Sept 2025), so nodemailer cannot deliver from
 * there no matter how correct the Gmail credentials are — and ours are, they
 * authenticate fine from anywhere that is not Render. An HTTP API needs no SMTP
 * port at all.
 */
async function sendViaHttp(message: Message): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
    // Matches the SMTP timeouts below: an OTP request waits on this, and an
    // admin staring at a dialog should get an answer either way.
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend returned ${response.status}: ${detail.slice(0, 200)}`);
  }
}

/** Send over SMTP. Works anywhere the ports are not blocked — local, paid hosts. */
async function sendViaSmtp(message: Message): Promise<void> {
  await getTransporter().sendMail({
    from: env.EMAIL_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

/**
 * Deliver a message, preferring whichever transport is configured and falling
 * back to the other.
 *
 * HTTP goes first when a key is present, rather than SMTP-then-fallback. On a
 * free Render instance SMTP does not fail fast — it fails at the connection
 * timeout — so trying it first would add ten seconds to every email before
 * falling back, on a request an admin is actively waiting on.
 *
 * Both are attempted before giving up, so a Resend outage still gets the code
 * out from a host where SMTP works, and vice versa. The combined failure names
 * both reasons; one of them is the real one and guessing wastes the reader's
 * time.
 */
async function deliver(message: Message): Promise<void> {
  const transports: Array<{ name: string; send: () => Promise<void> }> = [];
  if (env.RESEND_API_KEY) transports.push({ name: 'resend', send: () => sendViaHttp(message) });
  if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) transports.push({ name: 'smtp', send: () => sendViaSmtp(message) });

  if (transports.length === 0) {
    throw new Error('No email transport configured. Set RESEND_API_KEY, or GMAIL_USER and GMAIL_APP_PASSWORD.');
  }

  const failures: string[] = [];
  for (const transport of transports) {
    try {
      await transport.send();
      if (failures.length > 0) {
        console.warn(`[email] delivered via ${transport.name} after ${failures.join('; ')}`);
      }
      return;
    } catch (error) {
      failures.push(`${transport.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`All email transports failed — ${failures.join(' | ')}`);
}

/**
 * A decision the recipient did not make and needs to know about.
 *
 * Deliberately plain. These arrive unannounced — a shop owner is not sitting in
 * the app waiting to hear whether their application passed — so the subject has
 * to carry the outcome on its own, and the body has to be readable in a preview
 * pane on a phone. One heading, a few lines, and where relevant the reason,
 * because "rejected" without a reason just generates a support ticket.
 */
export async function sendNoticeEmail(params: {
  to: string;
  subject: string;
  heading: string;
  lines: string[];
  /** Quoted verbatim under the lines — a rejection reason or an admin's note. */
  detail?: string;
  tone?: 'good' | 'bad';
}): Promise<void> {
  const accent = params.tone === 'bad' ? '#f59e0b' : '#22c55e';
  const safeLines = params.lines.map(escapeHtml);

  const detailHtml = params.detail
    ? `<div style="padding:16px;background:#16213e;border-left:3px solid ${accent};border-radius:8px;margin:20px 0;">
         <p style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 6px;">Reason</p>
         <p style="margin:0;color:#e0e0e0;">${escapeHtml(params.detail)}</p>
       </div>`
    : '';

  await deliver({
    to: params.to,
    subject: params.subject,
    text: [params.heading, '', ...params.lines, ...(params.detail ? ['', `Reason: ${params.detail}`] : [])].join('\n'),
    html: `
      <div style="font-family: 'Inter', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #1a1a2e; border-radius: 16px; color: #e0e0e0;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #ef4444; font-size: 24px; margin: 0;">EzyPrint</h1>
        </div>
        <h2 style="color:#fff;font-size:18px;margin:0 0 16px;">${escapeHtml(params.heading)}</h2>
        ${safeLines.map((line) => `<p style="margin:0 0 12px;line-height:1.5;">${line}</p>`).join('')}
        ${detailHtml}
        <p style="color:#666;font-size:11px;margin-top:24px;border-top:1px solid #333;padding-top:16px;">
          You are receiving this because you have an EzyPrint account. Open the app for full details.
        </p>
      </div>
    `,
  });
}

/**
 * Send a password reset code.
 *
 * Separate from `sendOTPEmail` because the two say different things. That one
 * confirms an action the reader just took and is already looking at; this one
 * may be the first a reader hears of it, and if they did not ask for it that
 * fact is the important part of the message — so it leads with what to do about
 * an unexpected code rather than burying it in a footer.
 */
export async function sendPasswordResetEmail(
  to: string,
  otp: string,
  name?: string | null
): Promise<void> {
  const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hi,';
  const plainGreeting = name ? `Hi ${name},` : 'Hi,';

  await deliver({
    to,
    subject: `Reset your EzyPrint password — code ${otp}`,
    text: `${plainGreeting}\n\nUse this code to set a new EzyPrint password: ${otp}\n\nIt expires in 5 minutes and can be used once.\n\nIf you did not ask to reset your password, you can ignore this email — your current password still works and nothing has changed.`,
    html: `
      <div style="font-family: 'Inter', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #1a1a2e; border-radius: 16px; color: #e0e0e0;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #ef4444; font-size: 24px; margin: 0;">EzyPrint</h1>
          <p style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 2px;">Password Reset</p>
        </div>
        <p style="margin-bottom: 16px;">${greeting}</p>
        <p style="margin-bottom: 16px;">Use this code to set a new password:</p>
        <div style="text-align: center; padding: 24px; background: #16213e; border-radius: 12px; margin: 24px 0;">
          <p style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #ef4444; margin: 0;">${otp}</p>
        </div>
        <p style="color: #888; font-size: 13px;">It expires in <strong>5 minutes</strong> and can be used once.</p>
        <p style="color: #666; font-size: 11px; margin-top: 24px; border-top: 1px solid #333; padding-top: 16px;">
          Didn't ask for this? Ignore this email — your current password still works and nothing has changed.
        </p>
      </div>
    `,
  });
}

/**
 * Send an OTP verification email for a sensitive admin/account action.
 */
export async function sendOTPEmail(to: string, otp: string, actionLabel?: string): Promise<void> {
  const action = actionLabel || 'Sensitive Action Verification';
  const safeAction = escapeHtml(action);

  await deliver({
    to,
    // Header values are not HTML; both transports encode them. Body values are.
    subject: `Verification Code: ${otp} (${action})`,
    text: `You are attempting to perform a sensitive account action.\n\nYour verification code is: ${otp}\n\nThis code expires in 5 minutes. If you did not request this, please secure your account immediately.`,
    html: `
      <div style="font-family: 'Inter', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #1a1a2e; border-radius: 16px; color: #e0e0e0;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #ef4444; font-size: 24px; margin: 0;">EzyPrint</h1>
          <p style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 2px;">Security Verification</p>
        </div>
        <p style="margin-bottom: 16px;">You are attempting to perform: <strong style="color: #fff;">${safeAction}</strong></p>
        <div style="text-align: center; padding: 24px; background: #16213e; border-radius: 12px; margin: 24px 0;">
          <p style="color: #888; font-size: 12px; margin: 0 0 8px;">Your verification code</p>
          <p style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #ef4444; margin: 0;">${otp}</p>
        </div>
        <p style="color: #888; font-size: 13px;">This code expires in <strong>5 minutes</strong>.</p>
        <p style="color: #666; font-size: 11px; margin-top: 24px; border-top: 1px solid #333; padding-top: 16px;">If you did not request this, please secure your account immediately.</p>
      </div>
    `,
  });
}
