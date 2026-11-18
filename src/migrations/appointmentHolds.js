/**
 * @file appointmentHolds.js (migration, pure part)
 * @description Decides what the one-off migration must write so that the open appointments that
 * already exist carry the hold fields the new code relies on (`holdsCar`, `visitSeat`) — and which
 * situations make it unsafe to build the unique indexes. No database access here: the script feeds
 * it the open rows and applies the commands it returns.
 *
 *   holdsCar   true on every open row;
 *   visitSeat  on ONE row per visit (customer + start time): the row with the lowest appointment
 *              code. A visit keeps the seat it already has (`visitSeat`, or `slotSeat` of an old
 *              KAN-28 row); a visit without a seat gets the smallest free seat of its slot.
 *
 * Idempotent: only rows that are not already right get a command, so a second run is empty.
 * Non-destructive: it only ever `$set`s these two fields; nothing else is touched.
 *
 * Ref: .sdd/features/test-drive-capacity-guard/SPEC.md (REQ-222, INV-5, AC-31…33), PLAN.md 3.5
 */

import { leadRowOf, seatOf } from '../services/appointmentHolds.js';

const idOf = (value) => String(value);
const timeOf = (row) => new Date(row.scheduledAt).getTime();

/** The open rows of one visit: same customer, same start time. */
export const groupVisits = (rows) => {
  const visits = new Map();
  rows.forEach((row) => {
    const key = `${idOf(row.customer)}|${timeOf(row)}`;
    visits.set(key, [...(visits.get(key) ?? []), row]);
  });
  return [...visits.values()];
};

/**
 * Open rows that break the unique indexes the moment they are built. The migration must STOP when
 * there are any: a human has to decide which booking stays.
 *
 * @param {object[]} rows  Open rows.
 * @returns {{ car: object[], seat: object[] }}
 *   `car`: groups of rows holding the same car at the same time;
 *   `seat`: groups of visits that already hold the same seat at the same time.
 */
export const findDuplicates = (rows) => {
  const byCar = new Map();
  rows.forEach((row) => {
    const key = `${idOf(row.car)}|${timeOf(row)}`;
    byCar.set(key, [...(byCar.get(key) ?? []), row]);
  });
  const car = [...byCar.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ car: idOf(group[0].car), scheduledAt: new Date(timeOf(group[0])), codes: group.map((row) => row.appointmentCode).sort() }));

  const bySeat = new Map();
  groupVisits(rows).forEach((visit) => {
    const seat = visitSeatOf(visit);
    if (seat === null) return;
    const key = `${timeOf(visit[0])}|${seat}`;
    bySeat.set(key, [...(bySeat.get(key) ?? []), visit]);
  });
  const seat = [...bySeat.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      seat: visitSeatOf(group[0]),
      scheduledAt: new Date(timeOf(group[0][0])),
      codes: group.map((visit) => leadRowOf(visit).appointmentCode).sort(),
    }));
  return { car, seat };
};

/** The seat a visit already holds: its lead row's seat first, then any other row's, else null. */
function visitSeatOf(visitRows) {
  const lead = leadRowOf(visitRows);
  const own = seatOf(lead);
  if (own !== null) return own;
  const other = visitRows.map(seatOf).find((seat) => seat !== null);
  return other ?? null;
}

/**
 * What to write.
 *
 * @param {object[]} rows      Open rows (any order).
 * @param {number} capacity    Current slot capacity, only used to report visits above it.
 * @returns {{
 *   updates: Array<{ _id: *, appointmentCode: string, set: { holdsCar?: true, visitSeat?: number } }>,
 *   assigned: Array<{ code: string, seat: number, scheduledAt: Date }>,
 *   anomalies: Array<{ code: string, problem: string }>,
 *   overCapacity: Array<{ code: string, seat: number, scheduledAt: Date }>,
 * }}
 */
export const planBackfill = (rows, capacity) => {
  const visits = groupVisits(rows).sort((a, b) => leadRowOf(a).appointmentCode.localeCompare(leadRowOf(b).appointmentCode));
  const usedBySlot = new Map(); // start time → seats already held
  const take = (time, seat) => usedBySlot.set(time, new Set([...(usedBySlot.get(time) ?? []), seat]));

  // Seats that already exist (on any row) stay where they are, so assignment never collides with them.
  visits.forEach((visit) => {
    visit.map(seatOf).filter((seat) => seat !== null).forEach((seat) => take(timeOf(visit[0]), seat));
  });

  const updates = [];
  const assigned = [];
  const anomalies = [];
  const overCapacity = [];

  visits.forEach((visit) => {
    const lead = leadRowOf(visit);
    const time = timeOf(lead);
    let seat = visitSeatOf(visit);
    if (seat === null) {
      seat = 1;
      while ((usedBySlot.get(time) ?? new Set()).has(seat)) seat += 1;
      take(time, seat);
      assigned.push({ code: lead.appointmentCode, seat, scheduledAt: new Date(time) });
    }
    if (seat > capacity) overCapacity.push({ code: lead.appointmentCode, seat, scheduledAt: new Date(time) });

    const extraSeatRows = visit.filter((row) => row !== lead && (row.visitSeat !== undefined || row.slotSeat !== undefined));
    if (extraSeatRows.length > 0) {
      anomalies.push({ code: lead.appointmentCode, problem: `${extraSeatRows.length} other row(s) of the visit also carry a seat; left as they are` });
    }

    visit.forEach((row) => {
      const set = {};
      if (row.holdsCar !== true) set.holdsCar = true;
      if (row === lead && row.visitSeat !== seat) set.visitSeat = seat;
      if (Object.keys(set).length > 0) updates.push({ _id: row._id, appointmentCode: row.appointmentCode, set });
    });
  });

  return { updates, assigned, anomalies, overCapacity };
};

/**
 * The report a human reads before `--apply`.
 *
 * @param {{ dbName: string, rows: object[], capacity: number|null, capacitySource?: string, duplicates: ReturnType<typeof findDuplicates>, plan: ReturnType<typeof planBackfill>, now?: Date }} p
 */
export const buildReport = ({ dbName, rows, capacity, capacitySource = 'stored', duplicates, plan, now = new Date() }) => {
  const byType = rows.reduce((acc, row) => ({ ...acc, [row.type ?? 'UNKNOWN']: (acc[row.type ?? 'UNKNOWN'] ?? 0) + 1 }), {});
  return {
    dbName,
    generatedAt: now,
    openRows: rows.length,
    openRowsByType: byType,
    openVisits: groupVisits(rows).length,
    capacity,
    capacitySource,
    rowsToUpdate: plan.updates.length,
    seatsToAssign: plan.assigned,
    anomalies: plan.anomalies,
    overCapacity: plan.overCapacity,
    duplicateCars: duplicates.car,
    duplicateSeats: duplicates.seat,
    blocked: duplicates.car.length > 0 || duplicates.seat.length > 0,
  };
};

/** The report as printable lines (no connection string, no personal data: codes and ids only). */
export const formatReport = (report) => {
  const lines = [
    `Database: ${report.dbName}`,
    `Open appointment rows: ${report.openRows} in ${report.openVisits} visit(s) ${JSON.stringify(report.openRowsByType)}`,
    `maxGuestsPerSlot: ${report.capacity ?? 'unknown'} (${report.capacitySource})`,
    `Rows that need hold fields: ${report.rowsToUpdate}`,
    `Visits that will receive a seat: ${report.seatsToAssign.length}`,
  ];
  report.seatsToAssign.forEach((s) => lines.push(`  ${s.code} -> seat ${s.seat} at ${s.scheduledAt.toISOString()}`));
  if (report.overCapacity.length > 0) {
    lines.push(`WARNING ${report.overCapacity.length} visit(s) hold a seat above the current capacity (allowed, they keep it):`);
    report.overCapacity.forEach((s) => lines.push(`  ${s.code} seat ${s.seat} at ${s.scheduledAt.toISOString()}`));
  }
  report.anomalies.forEach((a) => lines.push(`NOTE ${a.code}: ${a.problem}`));
  if (report.duplicateCars.length > 0) {
    lines.push(`BLOCKING ${report.duplicateCars.length} car(s) booked twice at the same time:`);
    report.duplicateCars.forEach((d) => lines.push(`  car ${d.car} at ${d.scheduledAt.toISOString()}: ${d.codes.join(', ')}`));
  }
  if (report.duplicateSeats.length > 0) {
    lines.push(`BLOCKING ${report.duplicateSeats.length} seat(s) held by two visits at the same time:`);
    report.duplicateSeats.forEach((d) => lines.push(`  seat ${d.seat} at ${d.scheduledAt.toISOString()}: ${d.codes.join(', ')}`));
  }
  lines.push(report.blocked ? 'RESULT: blocked - resolve the duplicates above first; --apply would stop.' : 'RESULT: no duplicates, --apply can run.');
  return lines;
};

export default { groupVisits, findDuplicates, planBackfill, buildReport, formatReport };
