/**
 * @file appointmentMailService.js
 * @description Sends the customer e-mails of the test-drive feature WITHOUT ever being on
 * the critical path of a request (Spec REQ-029, NFR-07):
 *
 *   - `dispatchMail` returns immediately; the work (look up the customer, build the e-mail,
 *     send it) runs in the background. The caller has already written to the database.
 *   - Any failure (no e-mail address, provider down, template bug) is only logged. It never
 *     changes an API response and never undoes the change that triggered the mail.
 *   - No retry and no queue (C23): if a mail is lost, staff still phone the customer.
 *
 * The transport is loaded lazily and can be replaced (`setMailSender`), so tests can never
 * reach the real provider just by importing this module.
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-028, REQ-029, C23, INV-12)
 */

import { findCustomerContact } from './appointmentQueries.js';
import { buildMail } from './appointmentMailTemplates.js';
import { visitCodeOf } from './appointmentVisitRules.js';

let sender = null; // null → the real transport (src/config/mailer.js), imported on first use
const pending = new Set();

/** Replaces the transport (tests). Pass `null` to restore the real one. */
export const setMailSender = (fn) => { sender = fn; };

const transport = async (message) => {
  if (sender) return sender(message);
  const { sendMail } = await import('../config/mailer.js');
  return sendMail(message);
};

/** "MAZDA CX-5 2.0" style title; falls back to the vehicle code. */
export const carTitle = (car) =>
  [car?.make, car?.model, car?.variant].filter(Boolean).join(' ') || car?.vehicleCode || 'Xe';

/**
 * Plain, explicit data for the templates. `rows` are exactly the appointments the e-mail is
 * about (they decide the listed cars); the visit code is taken from the WHOLE visit
 * (`visitRows`) so it always equals the code the customer sees on screen.
 *
 * @param {object[]} rows         Appointments to list (same customer and `scheduledAt`).
 * @param {Map<string, object>} carsById
 * @param {object[]} [visitRows]  All visible rows of the visit; defaults to `rows`.
 */
export const describeVisit = (rows, carsById, visitRows = rows) => ({
  visitCode: visitCodeOf(visitRows),
  scheduledAt: rows[0].scheduledAt,
  location: rows[0].location ?? null,
  cars: rows.map((row) => carTitle(carsById.get(String(row.car)))),
});

const deliver = async ({ event, customerId, data }) => {
  const contact = await findCustomerContact(customerId);
  if (!contact?.email) {
    console.warn(`Appointment e-mail skipped (${event}): the customer has no e-mail address.`);
    return;
  }
  const mail = buildMail(event, { ...data, customerName: contact.fullName });
  await transport({ to: contact.email, toName: contact.fullName ?? '', ...mail });
};

/**
 * Fire-and-forget. NEVER throws and never returns a promise the caller could wait on.
 *
 * @param {{ event: string, customerId: *, data: object }} job
 */
export const dispatchMail = (job) => {
  const task = deliver(job)
    .catch((error) => console.error(`Appointment e-mail failed (${job.event}):`, error.message))
    .finally(() => pending.delete(task));
  pending.add(task);
};

/** Resolves when every mail dispatched so far has been handled (for tests and shutdown). */
export const awaitPendingMail = async () => {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
};

export default { dispatchMail, awaitPendingMail, setMailSender, describeVisit, carTitle };
