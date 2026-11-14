/**
 * @file appointmentInvariants.js
 * @description Invariants of the hold fields that must be true after ANY sequence of operations
 * (SPEC INV-1…3 of test-drive-capacity-guard). Use `expect(holdViolations(fakes.appointments)).toEqual([])`.
 *
 *   - a row that is not open carries no `holdsCar`, `visitSeat` or `slotSeat`;
 *   - no two open rows of one car share a start time and both hold the car;
 *   - no two open visits share a seat at one start time;
 *   - a visit whose rows carry holds has exactly one seat row (rows from before the migration,
 *     which carry no hold at all, are not judged).
 */

const OPEN = ['PENDING', 'CONFIRMED'];
const isOpen = (row) => OPEN.includes(row.status) && row.isActive !== false;
const timeOf = (row) => new Date(row.scheduledAt).getTime();

/** @returns {string[]} A human readable line for every violation (empty = all good). */
export const holdViolations = (rows) => {
  const problems = [];

  rows.filter((row) => !isOpen(row)).forEach((row) => {
    ['holdsCar', 'visitSeat', 'slotSeat'].forEach((field) => {
      if (row[field] !== undefined) problems.push(`${row.appointmentCode}: closed row still has ${field}`);
    });
  });

  const open = rows.filter(isOpen);
  const seen = new Map();
  open.filter((row) => row.holdsCar === true).forEach((row) => {
    const key = `car ${row.car}|${timeOf(row)}`;
    if (seen.has(key)) problems.push(`${row.appointmentCode}: car held twice at one time (${seen.get(key)})`);
    seen.set(key, row.appointmentCode);
  });

  const seats = new Map();
  open.filter((row) => typeof (row.visitSeat ?? row.slotSeat) === 'number').forEach((row) => {
    const key = `seat ${row.visitSeat ?? row.slotSeat}|${timeOf(row)}`;
    if (seats.has(key)) problems.push(`${row.appointmentCode}: seat held twice (${seats.get(key)})`);
    seats.set(key, row.appointmentCode);
  });

  const visits = new Map();
  open.forEach((row) => {
    const key = `${row.customer}|${timeOf(row)}`;
    visits.set(key, [...(visits.get(key) ?? []), row]);
  });
  visits.forEach((group) => {
    if (!group.some((row) => row.holdsCar === true)) return; // a visit from before the migration
    const seatRows = group.filter((row) => typeof row.visitSeat === 'number');
    if (seatRows.length !== 1) problems.push(`${group[0].appointmentCode}: open visit has ${seatRows.length} seat rows`);
    group.filter((row) => row.holdsCar !== true).forEach((row) => problems.push(`${row.appointmentCode}: open row of a holding visit does not hold its car`));
  });
  return problems;
};

export default { holdViolations };
