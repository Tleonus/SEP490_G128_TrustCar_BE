/**
 * @file appointment-transaction.test.js
 * @description The retry loop around booking transactions: which failures are retried, how many
 * times, and what the customer gets when retrying does not help.
 *
 * @ears .sdd/features/test-drive-capacity-guard/SPEC.md#REQ-213
 */

import { jest } from '@jest/globals';
import { runWithRetry, classifyError, RetryKind } from '../src/services/appointmentTransaction.js';
import { BOOKING_MAX_ATTEMPTS, CODE_COLLISION_MAX } from '../src/constants/appointmentRules.js';

const noSleep = async () => {};
const run = (work) => runWithRetry(work, { sleep: noSleep });
const duplicate = (keyPattern, message = 'E11000 duplicate key') => Object.assign(new Error(message), { code: 11000, keyPattern });
const transient = () => Object.assign(new Error('WriteConflict'), { hasErrorLabel: (label) => label === 'TransientTransactionError' });
const reject = (promise) => promise.then(() => null, (error) => error);

describe('classifyError', () => {
  it('recognises write conflicts and the three duplicate-key cases', () => {
    expect(classifyError(transient())).toBe(RetryKind.CONFLICT);
    expect(classifyError(duplicate({ appointmentCode: 1 }))).toBe(RetryKind.CODE);
    expect(classifyError(duplicate({ car: 1, scheduledAt: 1 }))).toBe(RetryKind.CAR);
    expect(classifyError(duplicate({ scheduledAt: 1, visitSeat: 1 }))).toBe(RetryKind.SEAT);
  });

  it('reads the index name from the message when keyPattern is missing', () => {
    expect(classifyError(duplicate(undefined, 'E11000 duplicate key error index: uniq_visit_car_time dup key'))).toBe(RetryKind.CAR);
    expect(classifyError(duplicate(undefined, 'E11000 ... index: uniq_visit_seat_time ...'))).toBe(RetryKind.SEAT);
    expect(classifyError(duplicate(undefined, 'E11000 ... appointmentCode_1 ...'))).toBe(RetryKind.CODE);
  });

  it('leaves every other error alone, including an unknown duplicate key', () => {
    expect(classifyError(new Error('disk full'))).toBeNull();
    expect(classifyError(duplicate({ somethingElse: 1 }))).toBeNull();
    expect(classifyError(null)).toBeNull();
  });
});

describe('runWithRetry', () => {
  it('returns the result at once when the first try works', async () => {
    const work = jest.fn(async () => 'ok');
    await expect(run(work)).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a write conflict', transient],
    ['a car clash', () => duplicate({ car: 1, scheduledAt: 1 })],
    ['a seat clash', () => duplicate({ scheduledAt: 1, visitSeat: 1 })],
  ])('retries %s and succeeds on the second try', async (_name, makeError) => {
    let calls = 0;
    const result = await run(async () => { calls += 1; if (calls === 1) throw makeError(); return 'ok'; });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('after the maximum attempts, a car clash becomes the "vehicle already booked" error, not a 500', async () => {
    let calls = 0;
    const error = await reject(run(async () => { calls += 1; throw duplicate({ car: 1, scheduledAt: 1 }); }));
    expect(calls).toBe(BOOKING_MAX_ATTEMPTS);
    expect(error).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_CONFLICT' });
  });

  it('after the maximum attempts, a seat clash becomes "slot full"', async () => {
    const error = await reject(run(async () => { throw duplicate({ scheduledAt: 1, visitSeat: 1 }); }));
    expect(error).toMatchObject({ statusCode: 409, code: 'APPOINTMENT_CAPACITY_FULL' });
  });

  it('after the maximum attempts, a write conflict that never resolves is a 409, not a 500', async () => {
    let calls = 0;
    const error = await reject(run(async () => { calls += 1; throw transient(); }));
    expect(calls).toBe(BOOKING_MAX_ATTEMPTS);
    expect(error.statusCode).toBe(409);
  });

  it('a duplicate appointment code is counted apart and does not use up the attempts', async () => {
    let calls = 0;
    const result = await run(async () => {
      calls += 1;
      if (calls <= BOOKING_MAX_ATTEMPTS + 2) throw duplicate({ appointmentCode: 1 });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(BOOKING_MAX_ATTEMPTS + 3);
  });

  it('gives up after too many code collisions with the generic 500', async () => {
    let calls = 0;
    const error = await reject(run(async () => { calls += 1; throw duplicate({ appointmentCode: 1 }); }));
    expect(calls).toBe(CODE_COLLISION_MAX);
    expect(error).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });

  it('mixed failures: each kind uses its own counter', async () => {
    let calls = 0;
    const result = await run(async () => {
      calls += 1;
      if (calls === 1) throw duplicate({ appointmentCode: 1 });
      if (calls === 2) throw transient();
      if (calls === 3) throw duplicate({ car: 1 });
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(4);
  });

  it('never swallows an unexpected error, and does not retry it', async () => {
    let calls = 0;
    const error = await reject(run(async () => { calls += 1; throw new Error('disk full'); }));
    expect(error.message).toBe('disk full');
    expect(calls).toBe(1);
  });

  it('passes the try number to the work and backs off between tries', async () => {
    const waits = [];
    const seen = [];
    let calls = 0;
    await runWithRetry(async (attempt) => { seen.push(attempt); calls += 1; if (calls < 3) throw transient(); return 'ok'; }, { sleep: async (n) => { waits.push(n); } });
    expect(seen).toEqual([1, 2, 3]);
    expect(waits).toEqual([1, 2]);
  });
});
