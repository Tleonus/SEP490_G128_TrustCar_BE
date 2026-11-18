/**
 * @file activity-log-list.test.js
 * @description KAN-40, HTTP layer: the list (order, paging, filters, DTO shape) and the filter meta.
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-003, 004, 006, 007, 010; AC-01, 03…07, 09…12, 16)
 */

import mongoose from 'mongoose';
import { API, setupActivityLogHttp } from './helpers/activityLogHttp.js';

const t = await setupActivityLogHttp();
const { ActivityEventType } = await import('../src/constants/appConstants.js');

let token;
beforeEach(async () => {
  t.reset();
  token = await t.tokenFor('ADMIN');
});

const get = (query = '') => t.send('get', `${API}${query}`, token);
const ids = (res) => res.body.data.map((item) => item.id);
const oid = () => new mongoose.Types.ObjectId();

describe('default page', () => {
  test('newest first, 20 per page, page 1', async () => {
    for (let i = 0; i < 25; i += 1) t.fake.addLog({ summary: `entry ${i}` });
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(20);
    expect(res.body.data[0].summary).toBe('entry 24');
    expect(res.body.data[19].summary).toBe('entry 5');
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 25, totalPages: 2, hasNext: true, hasPrev: false });
    const times = res.body.data.map((item) => new Date(item.createdAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test('an empty log is a normal empty page', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ total: 0, totalPages: 1, hasNext: false, hasPrev: false });
  });
});

describe('paging', () => {
  test('45 entries, limit 20, page 3 → the last 5', async () => {
    for (let i = 0; i < 45; i += 1) t.fake.addLog({ summary: `entry ${i}` });
    const res = await get('?limit=20&page=3');
    expect(res.body.data).toHaveLength(5);
    expect(res.body.meta).toEqual({ page: 3, limit: 20, total: 45, totalPages: 3, hasNext: false, hasPrev: true });
    expect(res.body.data[4].summary).toBe('entry 0');
  });

  test('pages do not overlap and together cover everything', async () => {
    for (let i = 0; i < 45; i += 1) t.fake.addLog();
    const seen = [];
    for (const page of [1, 2, 3]) seen.push(...ids(await get(`?limit=20&page=${page}`)));
    expect(new Set(seen).size).toBe(45);
  });

  test('limit 100 is allowed and returns up to 100', async () => {
    for (let i = 0; i < 120; i += 1) t.fake.addLog();
    const res = await get('?limit=100');
    expect(res.body.data).toHaveLength(100);
    expect(res.body.meta.totalPages).toBe(2);
  });

  test('a page past the end is empty but still 200', async () => {
    t.fake.addLog();
    const res = await get('?page=9');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(1);
  });
});

describe('order', () => {
  test('sort=asc puts the oldest first', async () => {
    for (let i = 0; i < 5; i += 1) t.fake.addLog({ summary: `entry ${i}` });
    const res = await get('?sort=asc');
    expect(res.body.data.map((item) => item.summary)).toEqual(['entry 0', 'entry 1', 'entry 2', 'entry 3', 'entry 4']);
  });

  test('entries with the same instant keep a stable order between two calls', async () => {
    const same = new Date('2026-11-10T00:00:00Z');
    for (let i = 0; i < 6; i += 1) t.fake.addLog({ createdAt: same });
    const first = ids(await get());
    const second = ids(await get());
    expect(second).toEqual(first);
    expect(ids(await get('?sort=asc'))).toEqual([...first].reverse());
  });
});

describe('filters', () => {
  test('eventType: only that type, and the total counts the filtered set', async () => {
    for (let i = 0; i < 3; i += 1) t.fake.addLog({ eventType: 'CAR_PRICE_UPDATED' });
    for (let i = 0; i < 2; i += 1) t.fake.addLog({ eventType: 'USER_LOGIN' });
    const res = await get('?eventType=CAR_PRICE_UPDATED');
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta.total).toBe(3);
    expect(res.body.data.every((item) => item.eventType === 'CAR_PRICE_UPDATED')).toBe(true);
  });

  test('targetModel, targetId and targetCode', async () => {
    const car = oid();
    t.fake.addLog({ targetModel: 'Car', targetId: car, targetCode: 'TC-1' });
    t.fake.addLog({ targetModel: 'Car', targetId: oid(), targetCode: 'TC-2' });
    t.fake.addLog({ targetModel: 'User', targetId: oid(), targetCode: null });
    expect((await get('?targetModel=Car')).body.data).toHaveLength(2);
    expect((await get(`?targetId=${car}`)).body.data).toHaveLength(1);
    expect((await get('?targetCode=TC-2')).body.data).toHaveLength(1);
    expect((await get('?targetModel=Car&targetCode=TC-1')).body.data).toHaveLength(1);
    expect((await get('?targetModel=User&targetCode=TC-1')).body.data).toHaveLength(0);
  });

  test('filters combine with AND', async () => {
    t.fake.addLog({ eventType: 'USER_LOGIN', performedByEmail: 'a@x.vn', createdAt: new Date('2026-11-15T03:00:00Z') });
    t.fake.addLog({ eventType: 'USER_LOGIN', performedByEmail: 'b@x.vn', createdAt: new Date('2026-11-15T03:00:00Z') });
    t.fake.addLog({ eventType: 'USER_LOGOUT', performedByEmail: 'a@x.vn', createdAt: new Date('2026-11-15T03:00:00Z') });
    t.fake.addLog({ eventType: 'USER_LOGIN', performedByEmail: 'a@x.vn', createdAt: new Date('2026-10-01T03:00:00Z') });
    const res = await get('?eventType=USER_LOGIN&actorEmail=a@x.vn&from=2026-11-01&to=2026-11-30');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });

  test('actorEmail ignores case and must match the whole address', async () => {
    t.fake.addLog({ performedByEmail: 'admin@trustcar.vn' });
    t.fake.addLog({ performedByEmail: 'Admin@TrustCar.VN' });
    t.fake.addLog({ performedByEmail: 'xadmin@trustcar.vn' });
    expect((await get('?actorEmail=ADMIN@TrustCar.vn')).body.data).toHaveLength(2);
    expect((await get('?actorEmail=admin@')).body.data).toHaveLength(0);
    expect((await get('?actorEmail=trustcar.vn')).body.data).toHaveLength(0);
  });

  test('regex characters in actorEmail are plain text', async () => {
    t.fake.addLog({ performedByEmail: 'a.b+c@x.vn' });
    t.fake.addLog({ performedByEmail: 'aXb+c@x.vn' });
    t.fake.addLog({ performedByEmail: 'abbc@x.vn' });
    expect((await get(`?actorEmail=${encodeURIComponent('a.b+c@x.vn')}`)).body.data).toHaveLength(1);
    expect((await get(`?actorEmail=${encodeURIComponent('.*')}`)).body.data).toHaveLength(0);
    expect((await get(`?actorEmail=${encodeURIComponent('(a+)+')}`)).status).toBe(200);
  });

  test('dates are Vietnam days: 00:30 VN on the 15th (17:30Z on the 14th) is on the 15th', async () => {
    t.fake.addLog({ summary: 'late', createdAt: new Date('2026-11-14T17:30:00Z') });
    t.fake.addLog({ summary: 'early', createdAt: new Date('2026-11-14T16:30:00Z') });
    expect((await get('?from=2026-11-15&to=2026-11-15')).body.data.map((i) => i.summary)).toEqual(['late']);
    expect((await get('?from=2026-11-14&to=2026-11-14')).body.data.map((i) => i.summary)).toEqual(['early']);
    expect((await get('?to=2026-11-14')).body.data.map((i) => i.summary)).toEqual(['early']);
    expect((await get('?from=2026-11-15')).body.data.map((i) => i.summary)).toEqual(['late']);
  });

  test('"to" includes the whole last day (23:59:59.999 VN) and excludes the next', async () => {
    t.fake.addLog({ summary: 'last ms', createdAt: new Date('2026-11-15T16:59:59.999Z') });
    t.fake.addLog({ summary: 'next day', createdAt: new Date('2026-11-15T17:00:00.000Z') });
    expect((await get('?to=2026-11-15')).body.data.map((i) => i.summary)).toEqual(['last ms']);
  });
});

describe('what a list row contains', () => {
  test('exactly the documented fields and nothing more', async () => {
    const car = oid();
    const actor = oid();
    t.fake.addLog({
      eventType: 'CAR_PRICE_UPDATED', performedBy: actor, performedByEmail: 'admin@trustcar.vn', targetModel: 'Car', targetId: car,
      targetCode: 'TC-2026-0001', summary: 'Price changed', ipAddress: '10.0.0.1', userAgent: 'UA',
      changes: { before: { price: 1 }, after: { price: 2 } }, metadata: { reason: 'x' },
    });
    const [item] = (await get()).body.data;

    expect(Object.keys(item).sort()).toEqual(['actor', 'createdAt', 'eventType', 'id', 'ipAddress', 'summary', 'target']);
    expect(item.actor).toEqual({ id: String(actor), email: 'admin@trustcar.vn' });
    expect(item.target).toEqual({ model: 'Car', id: String(car), code: 'TC-2026-0001' });
    expect(item.summary).toBe('Price changed');
    expect(item.ipAddress).toBe('10.0.0.1');
    expect(new Date(item.createdAt).toString()).not.toBe('Invalid Date');
    const text = JSON.stringify(item);
    for (const word of ['changes', 'metadata', 'userAgent', '"_id"', '__v', 'performedBy']) expect(text).not.toContain(word);
  });

  test('a system action has null actor id and email', async () => {
    t.fake.addLog({ performedBy: null, performedByEmail: null, eventType: 'PRICE_ALERT_SENT' });
    const [item] = (await get()).body.data;
    expect(item.actor).toEqual({ id: null, email: null });
    expect(item.target).toEqual({ model: null, id: null, code: null });
  });
});

describe('filter meta', () => {
  test('every known event type, sorted; object types distinct, non-blank, sorted', async () => {
    t.fake.addLog({ targetModel: 'User' });
    t.fake.addLog({ targetModel: 'Car' });
    t.fake.addLog({ targetModel: 'Car' });
    t.fake.addLog({ targetModel: null });
    t.fake.addLog({ targetModel: '  ' });
    const res = await t.send('get', `${API}/meta`, token);

    expect(res.status).toBe(200);
    expect(res.body.data.eventTypes).toEqual(Object.values(ActivityEventType).sort());
    expect(res.body.data.targetModels).toEqual(['Car', 'User']);
  });

  test('with an empty log there are still event types and no object types', async () => {
    const res = await t.send('get', `${API}/meta`, token);
    expect(res.body.data.eventTypes.length).toBeGreaterThan(30);
    expect(res.body.data.targetModels).toEqual([]);
  });
});
