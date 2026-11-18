/**
 * @file EmailLog.js
 * @description Append-only record of every email the platform attempts to send (KAN-39).
 *
 * Written from the single send path in config/mailer.js, so auth, test-drive and
 * wishlist emails are all covered without each caller knowing about logging.
 * The recipient address is masked: a delivery log is an operational record, not
 * a copy of the customer's contact details, and the body is never stored.
 */

import mongoose from 'mongoose';

export const EmailStatus = Object.freeze({
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED', // No transport configured; nothing left the server.
});

const EmailLogSchema = new mongoose.Schema(
  {
    toMasked: {
      type: String,
      required: true,
      // j***@example.com — enough to investigate, not enough to contact.
    },

    subject: {
      type: String,
      default: '',
    },

    // Which transport handled it: mailersend, smtp, or none.
    transport: {
      type: String,
      default: 'none',
    },

    status: {
      type: String,
      enum: Object.values(EmailStatus),
      required: true,
      index: true,
    },

    // Failure reason with the recipient address and content already stripped.
    error: {
      type: String,
      default: null,
    },

    sentAt: {
      type: Date,
      default: () => new Date(),
      index: true,
    },
  },
  { versionKey: false }
);

const EmailLog = mongoose.model('EmailLog', EmailLogSchema);

export default EmailLog;
