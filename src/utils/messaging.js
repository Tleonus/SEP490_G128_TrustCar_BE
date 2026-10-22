// src/utils/messaging.js
/**
 * Simple stub for email & SMS sending used by notificationService.
 * In a real environment replace with actual provider (SendGrid, Twilio, etc.).
 */

export const sendEmail = async (to, subject, body) => {
  // Very lightweight mock – just log to console.
  console.log(`[EMAIL] To: ${to} | Subject: ${subject}\n${body}`);
  // Simulate async behaviour
  return Promise.resolve();
};

export const sendSMS = async (to, message) => {
  console.log(`[SMS] To: ${to} | Message: ${message}`);
  return Promise.resolve();
};
