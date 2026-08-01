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

/**
 * Send an OTP verification email for a sensitive admin/account action.
 */
export async function sendOTPEmail(to: string, otp: string, actionLabel?: string): Promise<void> {
  const t = getTransporter();
  const action = actionLabel || 'Sensitive Action Verification';
  const safeAction = escapeHtml(action);

  await t.sendMail({
    from: `"EzyPrint Security" <${env.GMAIL_USER}>`,
    to,
    // Header values are not HTML; nodemailer encodes them. Body values are.
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
