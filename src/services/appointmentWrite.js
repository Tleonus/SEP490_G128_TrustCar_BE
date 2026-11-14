/**
 * @file appointmentWrite.js
 * @description Write-side helper shared by the flows that create appointment rows (booking,
 * staff booking, rescheduling): the APT codes of a new visit.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-210, REQ-213)
 */

import Appointment from '../models/Appointment.js';
import { SystemMessages as MSG } from '../constants/systemMessages.js';
import { generateAppointmentCode } from '../utils/codeGenerator.js';
import { fail } from './appointmentErrors.js';

const CODE_DIGITS = /^APT-(\d+)$/;
const formatCode = (number) => `APT-${String(number).padStart(number > 9999 ? 8 : 4, '0')}`;

/**
 * `count` consecutive appointment codes for the rows of ONE visit. `generateAppointmentCode` reads
 * outside any transaction, so calling it once per row would hand every row the same code: it is
 * called once and the rest are counted up from it. Two requests that start from the same code
 * collide on the unique `appointmentCode` and the transaction is retried with a fresh one.
 *
 * @param {number} count
 * @returns {Promise<string[]>}
 */
export const allocateCodes = async (count) => {
  const first = await generateAppointmentCode(Appointment);
  const start = Number(CODE_DIGITS.exec(first)?.[1]);
  if (!Number.isInteger(start)) throw fail(MSG.MSG62);
  return Array.from({ length: count }, (_, index) => formatCode(start + index));
};

export default { allocateCodes };
