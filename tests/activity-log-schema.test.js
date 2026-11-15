/**
 * @file activity-log-schema.test.js
 * @description KAN-40: every invalid query of the activity-log list answers 422 VALIDATION_ERROR on the
 * right field, with no further processing; every valid combination passes.
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-005; AC-08)
 */

import { validateQueryStrict } from '../src/routes/appointmentSchemas.js';
import { listQuery } from '../src/routes/activityLogSchemas.js';

const run = (query) => {
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
  const req = { query };
  let nextCalled = false;
  validateQueryStrict(listQuery)(req, res, () => { nextCalled = true; });
  return { res, req, nextCalled };
};

const fieldsOf = (result) => (result.res.body?.errors ?? []).map((e) => e.field);
const OID = '0123456789abcdef01234567';

describe('invalid input answers 422 VALIDATION_ERROR on the right field', () => {
  test.each([
    ['unknown event type', { eventType: 'NOT_A_TYPE' }, 'eventType'],
    ['lower-case event type', { eventType: 'user_login' }, 'eventType'],
    ['targetId not an ObjectId', { targetId: 'abc' }, 'targetId'],
    ['targetId too short', { targetId: '0123456789abcdef0123456' }, 'targetId'],
    ['date with wrong format', { from: '15/11/2026' }, 'from'],
    ['date that does not exist', { from: '2026-02-30' }, 'from'],
    ['month 13', { to: '2026-13-01' }, 'to'],
    ['to before from', { from: '2026-11-20', to: '2026-11-10' }, 'to'],
    ['limit 0', { limit: '0' }, 'limit'],
    ['limit 101', { limit: '101' }, 'limit'],
    ['limit negative', { limit: '-5' }, 'limit'],
    ['limit not a number', { limit: 'ten' }, 'limit'],
    ['limit a fraction', { limit: '2.5' }, 'limit'],
    ['page 0', { page: '0' }, 'page'],
    ['page not a number', { page: 'abc' }, 'page'],
    ['sort not asc/desc', { sort: 'up' }, 'sort'],
    ['sort in capitals', { sort: 'ASC' }, 'sort'],
    ['empty actorEmail', { actorEmail: '' }, 'actorEmail'],
    ['blank actorEmail', { actorEmail: '   ' }, 'actorEmail'],
    ['empty targetModel', { targetModel: '' }, 'targetModel'],
    ['empty targetCode', { targetCode: '' }, 'targetCode'],
    ['actorEmail longer than 200', { actorEmail: 'a'.repeat(201) }, 'actorEmail'],
    ['targetModel longer than 200', { targetModel: 'M'.repeat(201) }, 'targetModel'],
    ['targetCode longer than 200', { targetCode: 'C'.repeat(201) }, 'targetCode'],
    ['unknown parameter', { foo: '1' }, 'foo'],
    ['unknown parameter next to valid ones', { eventType: 'USER_LOGIN', q: 'x' }, 'q'],
    ['a repeated parameter (array)', { eventType: ['USER_LOGIN', 'USER_LOGOUT'] }, 'eventType'],
  ])('%s', (_label, query, field) => {
    const result = run(query);
    expect(result.nextCalled).toBe(false);
    expect(result.res.statusCode).toBe(422);
    expect(result.res.body).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(fieldsOf(result)).toContain(field);
    expect(JSON.stringify(result.res.body)).not.toMatch(/stack/i);
  });

  test('several problems are reported together', () => {
    const result = run({ eventType: 'X', limit: '0', foo: '1' });
    expect(fieldsOf(result).sort()).toEqual(['eventType', 'foo', 'limit']);
  });
});

describe('valid input passes and is normalised', () => {
  test('no parameters at all', () => {
    const result = run({});
    expect(result.nextCalled).toBe(true);
    expect(result.req.query).toEqual({});
  });

  test('limit 100 is the largest allowed page size', () => {
    expect(run({ limit: '100' }).nextCalled).toBe(true);
    expect(run({ limit: '1' }).nextCalled).toBe(true);
  });

  test('every filter at once', () => {
    const result = run({
      eventType: 'CAR_PRICE_UPDATED', targetModel: 'Car', targetId: OID, targetCode: 'TC-2026-0001',
      actorEmail: 'admin@trustcar.vn', from: '2026-11-01', to: '2026-11-30', sort: 'asc', page: '2', limit: '50',
    });
    expect(result.nextCalled).toBe(true);
    expect(result.req.query).toMatchObject({ page: 2, limit: 50, sort: 'asc', targetId: OID });
  });

  test('numbers arrive as numbers, text is trimmed, an upper-case id is lower-cased', () => {
    const result = run({ page: '3', actorEmail: '  admin@trustcar.vn ', targetId: OID.toUpperCase() });
    expect(result.req.query).toEqual({ page: 3, actorEmail: 'admin@trustcar.vn', targetId: OID });
  });

  test('from equal to to is allowed (one day)', () => {
    expect(run({ from: '2026-11-15', to: '2026-11-15' }).nextCalled).toBe(true);
  });

  test('only from, or only to', () => {
    expect(run({ from: '2026-11-15' }).nextCalled).toBe(true);
    expect(run({ to: '2026-11-15' }).nextCalled).toBe(true);
  });

  test('a leap day exists in 2028 but not in 2026', () => {
    expect(run({ from: '2028-02-29' }).nextCalled).toBe(true);
    expect(run({ from: '2026-02-29' }).nextCalled).toBe(false);
  });

  test('a text filter of exactly 200 characters is accepted', () => {
    expect(run({ actorEmail: 'a'.repeat(200) }).nextCalled).toBe(true);
  });
});
