/**
 * @file appointmentMailTemplates.js
 * @description Pure builders for the six customer e-mails of the test-drive feature.
 * Input is a small, explicit data object (never a database row): only the fields below
 * can ever reach an e-mail, so an internal note, outcome, staff name or price cannot leak
 * by accident (Spec C23, REQ-029, INV-12). Every dynamic string is HTML-escaped.
 *
 * Events: CREATED (customer booked, waiting for the confirmation call), CONFIRMED (also used
 * when staff book on behalf), CANCELLED_BY_CUSTOMER, CANCELLED_BY_STAFF (label of the chosen
 * reason only), CAR_UNAVAILABLE (system cancelled because a car stopped being for sale),
 * RESCHEDULED.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-028, REQ-029, C23, C24)
 */

import { emailButton, frontendUrl } from '../utils/emailLayout.js';
import { CANCEL_REASON_LABELS, VN_UTC_OFFSET_HOURS } from '../constants/appointmentRules.js';

export const MailEvent = Object.freeze({
  CREATED: 'CREATED',
  CONFIRMED: 'CONFIRMED',
  CANCELLED_BY_CUSTOMER: 'CANCELLED_BY_CUSTOMER',
  CANCELLED_BY_STAFF: 'CANCELLED_BY_STAFF',
  CAR_UNAVAILABLE: 'CAR_UNAVAILABLE',
  RESCHEDULED: 'RESCHEDULED',
});

const WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const two = (n) => String(n).padStart(2, '0');

/** "Thứ ba, 10:00 ngày 10/11/2026" in Vietnam time (fixed UTC+7, no ICU dependency). */
export const formatVnText = (date) => {
  const local = new Date(new Date(date).getTime() + VN_UTC_OFFSET_HOURS * 3600e3);
  return `${WEEKDAYS[local.getUTCDay()]}, ${two(local.getUTCHours())}:${two(local.getUTCMinutes())} `
    + `ngày ${two(local.getUTCDate())}/${two(local.getUTCMonth() + 1)}/${local.getUTCFullYear()}`;
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const paragraph = (html) => `<p style="margin:0 0 14px;line-height:1.55;">${html}</p>`;
const hello = (name) => paragraph(`Chào ${escapeHtml(name || 'bạn')},`);
const list = (items) => `<ul style="margin:0 0 14px;padding-left:20px;line-height:1.6;">${
  items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;

const detailRow = (label, value) => `<tr>
  <td style="padding:4px 16px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
  <td style="padding:4px 0;font-weight:600;">${escapeHtml(value)}</td></tr>`;

const details = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;">${
  rows.filter(Boolean).map(([label, value]) => detailRow(label, value)).join('')}</table>`;

const visitDetails = (d) => details([
  ['Mã lượt', d.visitCode],
  ['Thời gian', formatVnText(d.scheduledAt)],
  d.location ? ['Địa điểm', d.location] : null,
]);

const myVisitsButton = () => emailButton('Xem lịch hẹn của tôi', `${frontendUrl()}/lich-hen`);
const carsButton = () => emailButton('Xem các xe khác', `${frontendUrl()}/xe`);

const created = (d) => ({
  subject: `TrustCar: đã nhận lịch lái thử ${d.visitCode}`,
  preheader: 'Showroom sẽ gọi điện để xác nhận lịch hẹn của bạn.',
  html: hello(d.customerName)
    + paragraph('TrustCar đã nhận lịch hẹn lái thử của bạn. <strong>Nhân viên showroom sẽ gọi điện để xác nhận</strong> — lịch chỉ được giữ chính thức sau cuộc gọi đó.')
    + visitDetails(d) + paragraph('Xe lái thử:') + list(d.cars) + myVisitsButton(),
});

const confirmed = (d) => ({
  subject: `TrustCar: lịch lái thử ${d.visitCode} đã được xác nhận`,
  preheader: 'Lịch hẹn lái thử của bạn đã được xác nhận.',
  html: hello(d.customerName)
    + paragraph('Lịch hẹn lái thử của bạn đã được <strong>xác nhận</strong>. Hẹn gặp bạn tại showroom.')
    + visitDetails(d) + paragraph('Xe lái thử:') + list(d.cars)
    + paragraph('Nếu cần đổi hoặc hủy lịch, bạn có thể thao tác trên trang lịch hẹn hoặc gọi trực tiếp cho showroom.') + myVisitsButton(),
});

const cancelledByCustomer = (d) => ({
  subject: `TrustCar: bạn đã hủy lịch lái thử ${d.visitCode}`,
  preheader: 'Lịch hẹn lái thử đã được hủy theo yêu cầu của bạn.',
  html: hello(d.customerName)
    + paragraph('Lịch hẹn lái thử dưới đây đã được hủy theo yêu cầu của bạn.')
    + visitDetails(d) + paragraph('Xe:') + list(d.cars)
    + paragraph('Bạn có thể đặt lại lịch mới bất cứ lúc nào.') + carsButton(),
});

const cancelledByStaff = (d) => {
  const showReason = d.reasonLabel && d.reasonLabel !== CANCEL_REASON_LABELS.OTHER;
  return {
    subject: `TrustCar: showroom đã hủy lịch lái thử ${d.visitCode}`,
    preheader: 'Rất tiếc, lịch hẹn lái thử của bạn đã được hủy.',
    html: hello(d.customerName)
      + paragraph('Rất tiếc, <strong>showroom đã hủy</strong> lịch hẹn lái thử dưới đây.')
      + (showReason ? paragraph(`Lý do: ${escapeHtml(d.reasonLabel)}.`) : '')
      + visitDetails(d) + paragraph('Xe:') + list(d.cars)
      + paragraph('Xin lỗi vì sự bất tiện. Bạn có thể đặt lại một lịch hẹn khác.') + carsButton(),
  };
};

const carUnavailable = (d) => {
  const reserved = d.carStatus === 'RESERVED';
  const why = reserved
    ? 'đang được một khách hàng khác giữ chỗ'
    : 'hiện không còn được bán';
  const remaining = d.remainingCars?.length
    ? paragraph('Các xe còn lại trong lượt hẹn của bạn <strong>vẫn được giữ nguyên</strong>:') + list(d.remainingCars)
    : paragraph('Lượt hẹn này đã được hủy hoàn toàn.');
  return {
    subject: `TrustCar: lịch lái thử ${d.visitCode} có xe không còn khả dụng`,
    preheader: 'Một xe trong lịch hẹn của bạn không còn khả dụng.',
    html: hello(d.customerName)
      + paragraph(`Rất tiếc, xe sau ${why} nên lịch lái thử xe này đã được hủy tự động:`)
      + list(d.cars) + visitDetails(d) + remaining
      + paragraph('Bạn có thể chọn một xe khác và đặt lại lịch hẹn.') + carsButton(),
  };
};

const rescheduled = (d) => ({
  subject: `TrustCar: lịch lái thử đã được đổi sang ${d.visitCode}`,
  preheader: 'Lịch hẹn lái thử của bạn đã được đổi giờ.',
  html: hello(d.customerName)
    + paragraph('Lịch hẹn lái thử của bạn đã được <strong>đổi giờ</strong>.')
    + details([
      ['Giờ cũ', formatVnText(d.previousScheduledAt)],
      ['Giờ mới', formatVnText(d.scheduledAt)],
      ['Mã lượt mới', d.visitCode],
      ['Thay cho mã', d.previousVisitCode],
      d.location ? ['Địa điểm', d.location] : null,
    ])
    + paragraph('Xe lái thử:') + list(d.cars)
    + (d.needsConfirmation
      ? paragraph('Showroom sẽ gọi điện để xác nhận lại lịch hẹn mới của bạn.')
      : '')
    + myVisitsButton(),
});

const BUILDERS = Object.freeze({
  [MailEvent.CREATED]: created,
  [MailEvent.CONFIRMED]: confirmed,
  [MailEvent.CANCELLED_BY_CUSTOMER]: cancelledByCustomer,
  [MailEvent.CANCELLED_BY_STAFF]: cancelledByStaff,
  [MailEvent.CAR_UNAVAILABLE]: carUnavailable,
  [MailEvent.RESCHEDULED]: rescheduled,
});

/**
 * @param {string} event One of `MailEvent`.
 * @param {object} data  `{ customerName, visitCode, scheduledAt, location, cars: string[], previousVisitCode?,
 *                       previousScheduledAt?, reasonLabel?, carStatus?, remainingCars?, needsConfirmation? }`
 * @returns {{ subject: string, preheader: string, html: string }}
 */
export const buildMail = (event, data) => {
  const build = BUILDERS[event];
  if (!build) throw new Error(`Unknown appointment mail event: ${event}`);
  return build(data);
};

export default { MailEvent, buildMail, formatVnText };
