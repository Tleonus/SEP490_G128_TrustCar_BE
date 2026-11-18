/**
 * @file activity-log-access.test.js
 * @description KAN-40, HTTP layer on the real Express app (in-memory models): who may call the
 * admin activity-log endpoints, that invalid input costs zero queries, that nothing can be written
 * through them, and that errors leak nothing.
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-001, 002, 005, 011, 012; AC-02, 08, 17, 18, 19, 20)
 */

import mongoose from 'mongoose';
import { API, setupActivityLogHttp } from './helpers/activityLogHttp.js';

const t = await setupActivityLogHttp();
beforeEach(() => t.reset());

const oid = () => String(new mongoose.Types.ObjectId());
const ENDPOINTS = [
  ['list', API],
  ['meta', `${API}/meta`],
  ['detail', `${API}/${oid()}`],
];

describe('only an administrator may read', () => {
  test.each(ENDPOINTS)('%s without a token → 401 and no query', async (_n, url) => {
    t.fake.addLog();
    const res = await t.send('get', url);
    expect(res.status).toBe(401);
    expect(t.fake.reads.count).toBe(0);
  });

  test.each(ENDPOINTS)('%s with a bad token → 401 and no query', async (_n, url) => {
    const res = await t.send('get', url, 'not.a.token');
    expect(res.status).toBe(401);
    expect(t.fake.reads.count).toBe(0);
  });

  test.each([['SALES_STAFF'], ['CUSTOMER']])('%s gets 403 ROLE_INSUFFICIENT on every endpoint and no query runs', async (role) => {
    t.fake.addLog();
    const token = await t.tokenFor(role);
    for (const [, url] of ENDPOINTS) {
      const res = await t.send('get', url, token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ROLE_INSUFFICIENT');
    }
    expect(t.fake.reads.count).toBe(0);
  });

  test('an administrator gets 200 on all three', async () => {
    const entry = t.fake.addLog({ targetModel: 'Car' });
    const token = await t.tokenFor('ADMIN');
    expect((await t.send('get', API, token)).status).toBe(200);
    expect((await t.send('get', `${API}/meta`, token)).status).toBe(200);
    expect((await t.send('get', `${API}/${entry._id}`, token)).status).toBe(200);
  });

  test('"/meta" is the filter list, not an id', async () => {
    const token = await t.tokenFor('ADMIN');
    const res = await t.send('get', `${API}/meta`, token);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('eventTypes');
    expect(res.body.data).toHaveProperty('targetModels');
  });
});

describe('invalid input costs zero queries (422)', () => {
  test.each([
    ['unknown event type', '?eventType=NOT_A_TYPE'],
    ['bad target id', '?targetId=abc'],
    ['impossible date', '?from=2026-02-30'],
    ['to before from', '?from=2026-11-20&to=2026-11-10'],
    ['limit 0', '?limit=0'],
    ['limit 101', '?limit=101'],
    ['page abc', '?page=abc'],
    ['sort up', '?sort=up'],
    ['empty actor', '?actorEmail='],
    ['unknown parameter', '?foo=1'],
  ])('%s', async (_label, query) => {
    const token = await t.tokenFor('ADMIN');
    t.fake.reads.count = 0;
    const res = await t.send('get', `${API}${query}`, token);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(t.fake.reads.count).toBe(0);
  });

  test('a detail id in the wrong format is 422 and costs no query', async () => {
    const token = await t.tokenFor('ADMIN');
    t.fake.reads.count = 0;
    const res = await t.send('get', `${API}/not-an-object-id`, token);
    expect(res.status).toBe(422);
    expect(t.fake.reads.count).toBe(0);
  });
});

describe('read-only by construction', () => {
  test.each([['post'], ['put'], ['patch'], ['delete']])('%s on any of the paths is 404 and writes nothing', async (method) => {
    const token = await t.tokenFor('ADMIN');
    const id = oid();
    for (const url of [API, `${API}/meta`, `${API}/${id}`]) {
      const res = await t.send(method, url, token, {});
      expect(res.status).toBe(404);
    }
    expect(t.fake.writes.count).toBe(0);
  });

  test('every successful read leaves the log untouched: no write, no new log entry', async () => {
    const entry = t.fake.addLog({ targetModel: 'Car' });
    t.fake.addLog();
    const before = JSON.stringify(t.fake.rows);
    const token = await t.tokenFor('ADMIN');
    t.h.logs.length = 0;

    await t.send('get', API, token);
    await t.send('get', `${API}?eventType=USER_LOGIN&sort=asc`, token);
    await t.send('get', `${API}/meta`, token);
    await t.send('get', `${API}/${entry._id}`, token);

    expect(t.fake.writes.count).toBe(0);
    expect(t.h.logs).toHaveLength(0);
    expect(JSON.stringify(t.fake.rows)).toBe(before);
    expect(t.fake.rows).toHaveLength(2);
  });
});

describe('errors leak nothing', () => {
  test('401, 403, 404 and 422 bodies carry no stack trace, connection string or raw document', async () => {
    const admin = await t.tokenFor('ADMIN');
    const staff = await t.tokenFor('SALES_STAFF');
    const bodies = [
      (await t.send('get', API)).body,
      (await t.send('get', API, staff)).body,
      (await t.send('get', `${API}/${oid()}`, admin)).body,
      (await t.send('get', `${API}?limit=0`, admin)).body,
      (await t.send('get', `${API}/zzz`, admin)).body,
    ];
    for (const body of bodies) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/stack/i);
      expect(text).not.toMatch(/mongodb(\+srv)?:\/\//i);
      expect(text).not.toMatch(/node_modules|\.js:\d+/);
      expect(body.success).toBe(false);
    }
  });
});
