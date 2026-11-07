/**
 * @file appointment-code-generator.test.js
 * @description Next appointment code, including past APT-9999 where string order
 * and numeric order differ.
 */

import { generateAppointmentCode } from '../src/utils/codeGenerator.js';

/** Behaves like MongoDB here: filters by regex and sorts codes as strings. */
const modelWith = (codes) => ({
  findOne: async ({ appointmentCode: { $regex: pattern } }, _projection, { sort }) => {
    const direction = sort.appointmentCode;
    const [first] = codes
      .filter((code) => new RegExp(pattern).test(code))
      .sort((a, b) => (a < b ? -direction : direction));
    return first ? { appointmentCode: first } : null;
  },
});

const next = (codes) => generateAppointmentCode(modelWith(codes));

describe('generateAppointmentCode', () => {
  test('starts at APT-0001', async () => {
    await expect(next([])).resolves.toBe('APT-0001');
  });

  test('increments within four digits', async () => {
    await expect(next(['APT-0001', 'APT-0041', 'APT-0042'])).resolves.toBe('APT-0043');
  });

  test('moves to eight digits after APT-9999', async () => {
    await expect(next(['APT-9998', 'APT-9999'])).resolves.toBe('APT-00010000');
  });

  test('keeps counting once eight-digit codes exist', async () => {
    await expect(next(['APT-9999', 'APT-00010000'])).resolves.toBe('APT-00010001');
    await expect(next(['APT-0001', 'APT-9999', 'APT-00010000', 'APT-00010001', 'APT-00020000'])).resolves.toBe('APT-00020001');
  });
});
