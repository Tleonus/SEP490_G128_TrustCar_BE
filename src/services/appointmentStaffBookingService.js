/**
 * @file appointmentStaffBookingService.js
 * @description Staff book a visit ON BEHALF of a customer who phoned in (REQ-038…040), and
 * the customer search they need for it.
 *
 * Differences from a customer's own booking (Spec C19): the visit is CONFIRMED at once (the
 * staff member just spoke to the customer) and is assigned to them; the 2-hour lead time does
 * not apply (the slot only has to be in the future). Everything else is identical and runs on
 * the same core (`bookRows`): same capacity, same car and limit rules, same all-or-nothing
 * concurrency guarantee.
 *
 * Only customers who HAVE an account can be booked for: they can then see, move or cancel the
 * visit themselves. Walk-ins without an account are out of scope (C28).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-038…041, C19, C28)
 */

import { AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { STAFF_CUSTOMER_SEARCH_MAX, STAFF_CUSTOMER_SEARCH_MIN_CHARS } from '../constants/appointmentRules.js';
import { fail } from './appointmentErrors.js';
import { invalid } from './appointmentInput.js';
import { assertStaffBookableTime } from './appointmentSlotRules.js';
import { findCustomerWithAccount, loadVisitContext, searchCustomers } from './appointmentQueries.js';
import { bookRows } from './appointmentBookingService.js';
import { groupIntoVisits, needsReminderCall, needsOutcome } from './appointmentVisitRules.js';
import { toStaffVisit } from './appointmentVisitMapper.js';
import { logAppointmentEvents } from './appointmentAudit.js';
import { isNewRequest } from './appointmentStaffOrder.js';
import { MailEvent } from './appointmentMailTemplates.js';
import { dispatchMail, describeVisit } from './appointmentMailService.js';

/**
 * Customers matching a name, phone or e-mail fragment (at least 3 characters).
 *
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-038
 * @param {string} q
 * @returns {Promise<{ customers: Array<{ _id, fullName, phone, email }> }>}
 */
export const searchCustomersForStaff = async ({ q }) => {
  const text = typeof q === 'string' ? q.trim() : '';
  if (text.length < STAFF_CUSTOMER_SEARCH_MIN_CHARS) {
    throw invalid('q', `q must have at least ${STAFF_CUSTOMER_SEARCH_MIN_CHARS} characters.`);
  }
  return { customers: await searchCustomers(text, STAFF_CUSTOMER_SEARCH_MAX) };
};

/**
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-039
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-040
 * @ears .sdd/features/test-drive-booking/SPEC.md#REQ-041
 * @param {object} p
 * @param {string} p.userId      The staff member (`createdBy`, `confirmedBy`, `assignedTo`).
 * @param {string} p.customerId  The customer to book for (a `Customer` id).
 * @param {string[]} p.carIds    1..3 distinct car ids.
 * @param {Date} p.scheduledAt   A slot in the future, at most 60 days ahead.
 * @param {string} [p.notes]
 * @returns {Promise<object>} The staff view of the created, CONFIRMED visit.
 */
export const createVisitForCustomer = async (p) => {
  const { userId, customerId, ipAddress, now = new Date() } = p;
  if (!(await findCustomerWithAccount(customerId))) throw fail(MSG.MSG31);

  const { written, cars } = await bookRows({ ...p, now }, {
    assertTime: assertStaffBookableTime,
    extra: {
      status: AppointmentStatus.CONFIRMED, confirmedBy: userId, confirmedAt: now, assignedTo: userId,
    },
  });

  // One "created" entry per appointment, by the staff member (status PENDING means "created").
  try {
    await logAppointmentEvents(written, { status: AppointmentStatus.PENDING, userId, ipAddress });
  } catch (error) {
    console.error('Appointment audit log failed:', error.message);
  }
  const visit = groupIntoVisits(written)[0];
  const context = await loadVisitContext([visit], { staff: true });
  // The customer is told it is already confirmed (the staff member just agreed it by phone).
  dispatchMail({ event: MailEvent.CONFIRMED, customerId, data: describeVisit(written, context.carsById) });
  return toStaffVisit(visit, context.carsById, context.customersById, context.usersById, {
    rescheduleCount: 0,
    needsReminderCall: needsReminderCall(visit, now),
    needsOutcome: needsOutcome(visit, now),
    isNewRequest: isNewRequest(visit, now),
  });
};

export default { searchCustomersForStaff, createVisitForCustomer };
