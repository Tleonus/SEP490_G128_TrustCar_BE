/**
 * @file cpoCertificateBackfill.js
 * @description Issues CPO certificates to cars that were inspected and passed before the
 * digital inspection flow existed, so their public inspection report can be shown.
 *
 * Usage:
 *   node src/seeders/cpoCertificateBackfill.js --inspector=<email>          -> dry run, writes nothing
 *   node src/seeders/cpoCertificateBackfill.js --inspector=<email> --apply  -> writes to MONGODB_URI
 *
 * For every active APPROVED_CPO / AVAILABLE car without a certificate it writes, in one
 * transaction: a SUBMITTED + PASSED inspection record (5 criteria true, odo = car mileage,
 * no checklist, so the public report is MINIMAL) and the same code on Car.cpoCertificateId.
 * The inspector must be an active SALES_STAFF account; it is shown as initials on the report.
 * Idempotent: cars that already carry a certificate are not selected again.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { pathToFileURL } from 'url';
import Car from '../models/Car.js';
import InspectionRecord from '../models/InspectionRecord.js';
import User from '../models/User.js';
import { CarStatus, InspectionStatus, Roles } from '../constants/appConstants.js';
import { generateCpoCertificate } from '../services/inspectionVerdict.js';

const ELIGIBLE_STATUSES = [CarStatus.APPROVED_CPO, CarStatus.AVAILABLE];
const ALL_CRITERIA_PASSED = {
  noMajorAccident: true, noWaterDamage: true, engineGearboxIntact: true, verifiedOdo: true, electricalSystemPassed: true,
};
const BACKFILL_NOTE = 'Cấp chứng chỉ bổ sung cho xe đã kiểm định đạt trước khi có quy trình kiểm định số.';
const CODE_ATTEMPTS = 5;

/** A certificate code no other car uses yet. */
const uniqueCertificateCode = async () => {
  for (let i = 0; i < CODE_ATTEMPTS; i += 1) {
    const code = generateCpoCertificate();
    // eslint-disable-next-line no-await-in-loop
    if (!(await Car.exists({ cpoCertificateId: code }))) return code;
  }
  throw new Error('Could not generate a unique CPO certificate code.');
};

/** Writes the record and the car's code together, or neither. Returns false if the car changed meanwhile. */
const certifyCar = async (car, inspectorId, code, now) => {
  const session = await mongoose.startSession();
  try {
    let certified = false;
    await session.withTransaction(async () => {
      const { modifiedCount } = await Car.updateOne(
        { _id: car._id, cpoCertificateId: null, status: { $in: ELIGIBLE_STATUSES } },
        { $set: { cpoCertificateId: code } },
        { session },
      );
      certified = modifiedCount === 1;
      if (!certified) return;
      await InspectionRecord.create([{
        carId: car._id,
        inspectorId,
        createdBy: inspectorId,
        submittedBy: inspectorId,
        submittedAt: now,
        status: InspectionStatus.SUBMITTED,
        criteria: ALL_CRITERIA_PASSED,
        odo: car.mileage,
        result: 'PASSED',
        cpoCertificateId: code,
        notes: BACKFILL_NOTE,
      }], { session });
    });
    return certified;
  } finally {
    await session.endSession();
  }
};

/**
 * @param {object} options
 * @param {string} options.inspectorEmail - active SALES_STAFF account recorded as the inspector
 * @param {boolean} [options.apply=false] - false = only report what would be written
 * @param {(line: string) => void} [options.log=console.log]
 * @returns {Promise<{ candidates: number, certified: number, skipped: number }>}
 */
export const backfillCpoCertificates = async ({ inspectorEmail, apply = false, log = console.log }) => {
  const email = String(inspectorEmail || '').trim().toLowerCase();
  if (!email) throw new Error('Missing --inspector=<email>.');
  // KAN-54: INSPECTOR merged into SALES_STAFF
  const inspector = await User.findOne({ email, roleName: Roles.SALES_STAFF, isActive: true })
    .select('_id fullName').lean();
  if (!inspector) throw new Error(`No active SALES_STAFF account with email ${email}.`);

  const cars = await Car.find(
    { isActive: true, status: { $in: ELIGIBLE_STATUSES }, cpoCertificateId: null },
    { vehicleCode: 1, make: 1, model: 1, year: 1, mileage: 1, status: 1 },
  ).lean();
  log(`Inspector: ${inspector.fullName} | cars without certificate: ${cars.length}`);

  const result = { candidates: cars.length, certified: 0, skipped: 0 };
  const now = new Date();
  for (const car of cars) {
    const label = `${car.vehicleCode || car._id} ${car.make} ${car.model} ${car.year} (${car.status})`;
    if (!Number.isFinite(car.mileage) || car.mileage < 0) {
      result.skipped += 1;
      log(`  skip ${label}: no mileage`);
    } else if (!apply) {
      log(`  would certify ${label} | ${car.mileage} km`);
    } else {
      // Sequential on purpose: each code is checked against codes issued just before it.
      // eslint-disable-next-line no-await-in-loop
      const code = await uniqueCertificateCode();
      // eslint-disable-next-line no-await-in-loop
      const done = await certifyCar(car, inspector._id, code, now);
      if (done) result.certified += 1; else result.skipped += 1;
      log(`  ${done ? `certified ${label} -> ${code}` : `skip ${label}: changed meanwhile`}`);
    }
  }
  log(apply ? `Certified ${result.certified}, skipped ${result.skipped}.` : 'Dry run only. Re-run with --apply to write.');
  return result;
};

const run = async () => {
  const inspectorArg = process.argv.find((a) => a.startsWith('--inspector='));
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const { host, name } = mongoose.connection;
  console.log(`Target: ${host} / db: ${name} (${apply ? 'APPLY' : 'DRY RUN'})`);
  try {
    await backfillCpoCertificates({ inspectorEmail: inspectorArg?.split('=')[1], apply });
  } finally {
    await mongoose.disconnect();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error('CPO certificate backfill failed:', error.message);
    process.exit(1);
  });
}
