/**
 * @file audit-log-explorer.test.js
 * @description KAN-92: Audit Log Explorer API under /api/v1/manage/audit-logs — access, the new
 * `action` / `actorId` filters, the derived `action` of each row and the extended filter meta.
 */

import mongoose from 'mongoose';
import { setupActivityLogHttp } from './helpers/activityLogHttp.js';

const t = await setupActivityLogHttp();
const { ActivityEventType } = await import('../src/constants/appConstants.js');
const { AuditAction, actionOf, eventTypesOf } = await import('../src/constants/auditActions.js');
const { buildFilter } = await import('../src/services/activityLogFilter.js');

const API = '/api/v1/manage/audit-logs';
const oid = () => new mongoose.Types.ObjectId();

let token;
beforeEach(async () => {
  t.reset();
  token = await t.tokenFor('ADMIN');
});

const get = (query = '') => t.send('get', `${API}${query}`, token);

describe('auditActions: every event type has exactly one action', () => {
  test('known examples', () => {
    expect(actionOf('CAR_CREATED')).toBe('CREATE');
    expect(actionOf('CAR_PRICE_UPDATED')).toBe('UPDATE');
    expect(actionOf('CAR_IMAGE_REMOVED')).toBe('DELETE');
    expect(actionOf('LEAD_STAGE_CHANGED')).toBe('STATUS_CHANGE');
    expect(actionOf('USER_LOGIN')).toBe('AUTH');
    expect(actionOf('CAR_PUBLISHED_FACEBOOK')).toBe('OTHER');
    expect(actionOf('NOT_A_TYPE')).toBe('OTHER');
    expect(actionOf(undefined)).toBe('OTHER');
  });

  test('groups partition the event types (no overlap, nothing lost)', () => {
    const all = Object.values(AuditAction).flatMap((action) => eventTypesOf(action));
    expect(all.sort()).toEqual(Object.values(ActivityEventType).sort());
  });
});

describe('buildFilter: action and actorId', () => {
  test('action alone becomes $in of its event types', () => {
    expect(buildFilter({ action: 'DELETE' }).eventType).toEqual({ $in: eventTypesOf('DELETE') });
  });

  test('action + eventType inside the action keeps the event type', () => {
    expect(buildFilter({ action: 'UPDATE', eventType: 'CAR_UPDATED' }).eventType).toBe('CAR_UPDATED');
  });

  test('action + eventType outside the action matches nothing', () => {
    expect(buildFilter({ action: 'DELETE', eventType: 'CAR_CREATED' }).eventType).toEqual({ $in: [] });
  });

  test('actorId matches performedBy as an ObjectId', () => {
    const id = oid();
    const filter = buildFilter({ actorId: String(id) });
    expect(filter.performedBy).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(filter.performedBy)).toBe(String(id));
  });
});

describe('access', () => {
  test('no token → 401', async () => {
    expect((await t.send('get', API)).status).toBe(401);
  });

  test('staff who is not admin → 403, for list, meta and detail', async () => {
    const staff = await t.tokenFor('SALES_STAFF');
    expect((await t.send('get', API, staff)).status).toBe(403);
    expect((await t.send('get', `${API}/meta`, staff)).status).toBe(403);
    expect((await t.send('get', `${API}/${oid()}`, staff)).status).toBe(403);
  });

  test('admin → 200 and the old /admin/activity-logs path still works', async () => {
    t.fake.addLog();
    expect((await get()).status).toBe(200);
    expect((await t.send('get', '/api/v1/admin/activity-logs', token)).status).toBe(200);
  });
});

describe('list', () => {
  test('newest first and every row carries its action', async () => {
    t.fake.addLog({ eventType: 'CAR_CREATED', summary: 'old' });
    t.fake.addLog({ eventType: 'CAR_UPDATED', summary: 'new' });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.map((i) => i.summary)).toEqual(['new', 'old']);
    expect(res.body.data.map((i) => i.action)).toEqual(['UPDATE', 'CREATE']);
  });

  test('?action=CREATE keeps only create events', async () => {
    t.fake.addLog({ eventType: 'CAR_CREATED' });
    t.fake.addLog({ eventType: 'LEAD_CREATED' });
    t.fake.addLog({ eventType: 'CAR_UPDATED' });
    t.fake.addLog({ eventType: 'USER_LOGIN' });
    const res = await get('?action=CREATE');
    expect(res.body.meta.total).toBe(2);
    expect(res.body.data.every((i) => i.action === 'CREATE')).toBe(true);
  });

  test('?actorId combines with action, object type and date (AND)', async () => {
    const a = oid();
    const b = oid();
    t.fake.addLog({ performedBy: a, eventType: 'CAR_UPDATED', targetModel: 'Car', createdAt: new Date('2026-11-15T03:00:00Z'), summary: 'hit' });
    t.fake.addLog({ performedBy: a, eventType: 'CAR_CREATED', targetModel: 'Car', createdAt: new Date('2026-11-15T03:00:00Z') });
    t.fake.addLog({ performedBy: b, eventType: 'CAR_UPDATED', targetModel: 'Car', createdAt: new Date('2026-11-15T03:00:00Z') });
    t.fake.addLog({ performedBy: a, eventType: 'CAR_UPDATED', targetModel: 'Car', createdAt: new Date('2026-11-20T03:00:00Z') });
    const res = await get(`?actorId=${a}&action=UPDATE&targetModel=Car&from=2026-11-15&to=2026-11-15`);
    expect(res.body.data.map((i) => i.summary)).toEqual(['hit']);
  });

  test.each([
    ['unknown action', '?action=PATCH', 'action'],
    ['lower-case action', '?action=create', 'action'],
    ['actorId not an ObjectId', '?actorId=abc', 'actorId'],
    ['empty actorId', '?actorId=', 'actorId'],
  ])('%s → 422 on %s', async (_, query, field) => {
    const res = await get(query);
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e) => e.field)).toContain(field);
  });
});

describe('detail', () => {
  test('returns changes before/after with the action', async () => {
    const doc = t.fake.addLog({ eventType: 'CAR_PRICE_UPDATED', changes: { before: { price: 1 }, after: { price: 2 } } });
    const res = await get(`/${doc._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.action).toBe('UPDATE');
    expect(res.body.data.changes).toEqual({ before: { price: 1 }, after: { price: 2 } });
  });

  test('unknown id → 404', async () => {
    expect((await get(`/${oid()}`)).status).toBe(404);
  });
});

describe('meta', () => {
  test('actions, event → action map and distinct actor e-mails', async () => {
    t.fake.addLog({ performedByEmail: 'b@trustcar.vn' });
    t.fake.addLog({ performedByEmail: 'A@trustcar.vn' });
    t.fake.addLog({ performedByEmail: 'a@TRUSTCAR.vn' });
    t.fake.addLog({ performedByEmail: null });
    t.fake.addLog({ performedByEmail: '  ' });
    const res = await get('/meta');

    expect(res.status).toBe(200);
    expect(res.body.data.actions).toEqual(Object.values(AuditAction));
    expect(res.body.data.eventActions.CAR_CREATED).toBe('CREATE');
    expect(Object.keys(res.body.data.eventActions).sort()).toEqual(Object.values(ActivityEventType).sort());
    expect(res.body.data.actorEmails).toEqual(['A@trustcar.vn', 'b@trustcar.vn']);
  });

  test('reading never writes to the log', async () => {
    t.fake.addLog();
    await get();
    await get('/meta');
    expect(t.fake.writes.count).toBe(0);
  });
});
