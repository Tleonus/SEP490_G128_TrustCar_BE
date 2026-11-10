/**
 * @file appointmentWrite.js
 * @description Write-side helpers shared by every flow that creates appointment rows
 * (booking, rescheduling, staff booking). Keeping ONE copy of "check, insert with a fresh
 * APT code, hide on failure" is what lets all of them share the same proven concurrency
 * argument (see appointmentBookingRules.js).
 *
 * Ref: .sdd/features/test-drive-booking/SPEC.md (REQ-012, REQ-033, C9, C15, INV-2/3/4/10)
 */

import Appointment from '../models/Appointment.js';
import { AppointmentStatus } from '../constants/appConstants.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { CODE_RETRY_LIMIT } from '../constants/appointmentRules.js';
import { generateAppointmentCode } from '../utils/codeGenerator.js';
import { fail } from './appointmentErrors.js';
import { evaluateBooking } from './appointmentBookingRules.js';
import { findOpenAtSlot, findCustomerOpen, plain } from './appointmentQueries.js';

const isDuplicateCode = (error) =>
  error?.code === 11000 && (error.keyPattern?.appointmentCode || /appointmentCode/.test(error.message ?? ''));

/**
 * Rule check against the CURRENT database state.
 * `mine` = ids of rows that must not count against the request (rows it wrote itself and,
 * when rescheduling, the rows of the visit being moved).
 *
 * @returns {Promise<null | { kind: string, carIds?: string[] }>}
 */
export const violationNow = async ({ customerId, carIds, scheduledAt, mine, now }) => {
  const [slotRows, customerRows] = await Promise.all([
    findOpenAtSlot(scheduledAt),
    findCustomerOpen(customerId, now),
  ]);
  return evaluateBooking({ slotRows, customerRows, customerId, carIds, scheduledAt, mine, now });
};

/** Inserts one row, regenerating the APT code when another request took it (C15). */
export const insertWithCode = async (data) => {
  for (let attempt = 1; attempt <= CODE_RETRY_LIMIT; attempt += 1) {
    const appointmentCode = await generateAppointmentCode(Appointment);
    try {
      return plain(await Appointment.create({ ...data, appointmentCode }));
    } catch (error) {
      if (!isDuplicateCode(error)) throw error;
    }
  }
  throw fail(MSG.MSG62);
};

/** Soft-hides rows so they vanish from every API and free their car/slot/limits. Never throws. */
export const hideRows = async (rows, userId, reason) => {
  if (rows.length === 0) return;
  try {
    await Appointment.updateMany(
      { _id: { $in: rows.map((row) => row._id) } },
      { $set: { status: AppointmentStatus.CANCELLED, isActive: false, cancellationReason: reason, updatedBy: userId } },
    );
  } catch (error) {
    console.error('Appointment cleanup failed after a booking error:', error.message);
  }
};

export default { violationNow, insertWithCode, hideRows };
