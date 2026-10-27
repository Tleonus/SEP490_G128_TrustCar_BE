/**
 * @file mailer.js
 * @description Email transport configuration with MailerSend as primary dispatcher
 * and Nodemailer SMTP as automatic fallback.
 *
 * Pattern: Singleton – a single mailer instance is created and exported.
 * Strategy: Try MailerSend first; if MAILERSEND_API_KEY is absent, fall back
 * to the Nodemailer SMTP transport configured via SMTP_* env vars.
 *
 * Usage:
 *   import { sendMail } from '../config/mailer.js';
 *   await sendMail({ to, subject, html, text });
 */

import { MailerSend, EmailParams, Sender, Recipient } from 'mailersend';
import nodemailer from 'nodemailer';

// ── MailerSend Primary Transport ──────────────────────────────────────────────

let mailersendClient = null;

if (process.env.MAILERSEND_API_KEY) {
  mailersendClient = new MailerSend({ apiKey: process.env.MAILERSEND_API_KEY });
  console.log('✅  Mailer: MailerSend transport ready.');
}

// ── Nodemailer SMTP Fallback Transport ────────────────────────────────────────

let smtpTransport = null;

if (!mailersendClient) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    smtpTransport = nodemailer.createTransport({
      host:   SMTP_HOST,
      port:   Number(SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: SMTP_USER, pass: SMTP_PASS },
    });
    console.log(`✅  Mailer: Nodemailer SMTP fallback ready (host: ${SMTP_HOST})`);
  } else {
    console.warn('⚠️   Mailer: No email transport configured – emails will be no-op in development.');
  }
}

// ── Unified Send Interface ─────────────────────────────────────────────────────

/**
 * @typedef {Object} MailOptions
 * @property {string}   to        - Recipient email address.
 * @property {string}   [toName]  - Recipient display name.
 * @property {string}   subject   - Email subject line.
 * @property {string}   html      - HTML email body.
 * @property {string}   [text]    - Plain text fallback body.
 */

/**
 * Sends an email using the configured transport (MailerSend or SMTP fallback).
 * In development without a transport configured, the email is logged to console.
 *
 * @param {MailOptions} options
 * @returns {Promise<void>}
 */
export const sendMail = async ({ to, toName = '', subject, html, text }) => {
  const fromEmail = process.env.MAILERSEND_FROM_EMAIL || process.env.SMTP_USER || 'noreply@trustcar.vn';
  const fromName  = process.env.MAILERSEND_FROM_NAME  || 'TrustCar Platform';

  // ── MailerSend Path ───────────────────────────────────────────────────────
  if (mailersendClient) {
    const sentFrom  = new Sender(fromEmail, fromName);
    const recipients = [new Recipient(to, toName || to)];

    const emailParams = new EmailParams()
      .setFrom(sentFrom)
      .setTo(recipients)
      .setSubject(subject)
      .setHtml(html)
      .setText(text || html.replace(/<[^>]*>/g, '')); // Strip HTML for plain text

    await mailersendClient.email.send(emailParams);
    console.log(`📧  Email sent via MailerSend to: ${to} | Subject: "${subject}"`);
    return;
  }

  // ── SMTP Fallback Path ───────────────────────────────────────────────────
  if (smtpTransport) {
    await smtpTransport.sendMail({
      from:    `"${fromName}" <${fromEmail}>`,
      to,
      subject,
      html,
      text:    text || html.replace(/<[^>]*>/g, ''),
    });
    console.log(`📧  Email sent via SMTP to: ${to} | Subject: "${subject}"`);
    return;
  }

  // ── Development No-Op ─────────────────────────────────────────────────────
  console.log(`📧  [DEV] Email not sent (no transport). Would send to: ${to}`);
  console.log(`    Subject: "${subject}"`);
};

export default { sendMail };
