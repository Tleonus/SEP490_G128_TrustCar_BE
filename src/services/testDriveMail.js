/**
 * @file testDriveMail.js
 * @description Test-drive emails to customers. A failed email never fails the
 * operation that caused it: the error is logged without the full address.
 *
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-041
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-045
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-049
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-052
 * @ears .sdd/features/kan-28-test-drive-timeslot-management/SPEC.md#REQ-054
 */

import { sendMail } from '../config/mailer.js';
import Car from '../models/Car.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';
import { toLocalIso } from './testDriveSlots.js';

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

/** j***@example.com: enough to investigate a failure without exposing the address. */
export const maskEmail = (email) => `${String(email).charAt(0)}***@${String(email).split('@')[1] ?? ''}`;

/** The account email, or the showroom profile's when the account has none. */
export const findCustomerRecipient = async (customerId) => {
  const [account, profile] = await Promise.all([
    User.findOne({ customer: customerId }).select('email fullName').lean(),
    Customer.findById(customerId).select('email fullName').lean(),
  ]);
  const email = account?.email || profile?.email;
  return email ? { email, name: account?.fullName || profile?.fullName || '' } : null;
};

const describeCar = async (carId) => {
  const car = await Car.findById(carId).select('make model year').lean();
  return car ? `${car.make} ${car.model} ${car.year}` : 'xe đã đặt';
};

/** "09:00 ngày 10/11/2026", from the showroom-local ISO string. */
const describeTime = (instant) => {
  const iso = toLocalIso(instant);
  return `${iso.slice(11, 16)} ngày ${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
};

const detailLines = async (appointment) => `
  <p style="margin:0 0 4px;">Mã lịch: <strong>${escapeHtml(appointment.appointmentCode)}</strong></p>
  <p style="margin:0 0 4px;">Xe: <strong>${escapeHtml(await describeCar(appointment.car))}</strong></p>
  <p style="margin:0 0 4px;">Giờ hẹn: <strong>${escapeHtml(describeTime(appointment.scheduledAt))}</strong></p>`;

/**
 * Sends the 1-hour reminder.
 * @returns {Promise<boolean>} false when the customer has no email address
 * @throws when sending fails, so the caller can retry on the next scan
 */
export const sendReminderEmail = async (appointment) => {
  const recipient = await findCustomerRecipient(appointment.customer);
  if (!recipient) return false;

  const location = appointment.location
    ? `<p style="margin:0 0 4px;">Địa điểm: <strong>${escapeHtml(appointment.location)}</strong></p>`
    : '';
  await sendMail({
    to: recipient.email,
    toName: recipient.name,
    subject: 'TrustCar – Nhắc lịch lái thử',
    preheader: 'Bạn có lịch lái thử sau khoảng 1 giờ nữa.',
    html: `
      <h2 style="margin:0 0 16px;font-size:22px;color:#ffffff;">Nhắc lịch lái thử</h2>
      <p style="margin:0 0 12px;">Xin chào ${escapeHtml(recipient.name)}, bạn có lịch lái thử sau khoảng 1 giờ nữa.</p>
      ${await detailLines(appointment)}
      ${location}`,
  });
  return true;
};

/**
 * Sends a notification whose failure must not affect the operation that caused it.
 * Never throws; a customer without an address simply gets no email.
 *
 * @param {object} appointment
 * @param {string} label - Names the email in the log.
 * @param {(greeting: string) => Promise<{subject: string, preheader: string, html: string}>} compose
 */
const notifyCustomer = async (appointment, label, compose) => {
  let recipient = null;
  try {
    recipient = await findCustomerRecipient(appointment.customer);
    if (!recipient) return;
    const message = await compose(`Xin chào ${escapeHtml(recipient.name)}`);
    await sendMail({ to: recipient.email, toName: recipient.name, ...message });
  } catch (error) {
    const to = recipient ? maskEmail(recipient.email) : 'unknown recipient';
    // Not error.message: SMTP replies can echo the recipient's address.
    logger.error(`${label} email failed for appointment ${appointment._id} (${to}): ${error.code || error.name}`);
  }
};

/** Tells the customer an appointment was cancelled and why. */
export const sendCancellationEmail = (appointment) => notifyCustomer(appointment, 'Cancellation', async (greeting) => ({
  subject: 'TrustCar – Lịch lái thử đã bị hủy',
  preheader: 'Lịch lái thử của bạn đã bị hủy.',
  html: `
    <h2 style="margin:0 0 16px;font-size:22px;color:#ffffff;">Lịch lái thử đã bị hủy</h2>
    <p style="margin:0 0 12px;">${greeting}, lịch lái thử của bạn đã bị hủy.</p>
    ${await detailLines(appointment)}
    <p style="margin:12px 0 0;">Lý do: ${escapeHtml(appointment.cancellationReason)}</p>`,
}));

/** Tells the customer the booking was received and now waits for staff. */
export const sendBookingReceivedEmail = (appointment) => notifyCustomer(appointment, 'Booking received', async (greeting) => ({
  subject: 'TrustCar – Đã nhận yêu cầu đặt lịch lái thử',
  preheader: 'Yêu cầu đặt lịch của bạn đang chờ nhân viên xác nhận.',
  html: `
    <h2 style="margin:0 0 16px;font-size:22px;color:#ffffff;">Đã nhận yêu cầu đặt lịch</h2>
    <p style="margin:0 0 12px;">${greeting}, TrustCar đã nhận yêu cầu đặt lịch lái thử của bạn. Lịch đang chờ nhân viên xác nhận.</p>
    ${await detailLines(appointment)}`,
}));

export default { sendReminderEmail, sendCancellationEmail, sendBookingReceivedEmail, findCustomerRecipient, maskEmail };
