/**
 * @file activity-log-detail.test.js
 * @description KAN-40, HTTP layer: one log entry in full, with secret-like values hidden, 404/422 handling.
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-008, 009, 011, 012; AC-13…15, 18, 20)
 */

import mongoose from 'mongoose';
import { API, setupActivityLogHttp } from './helpers/activityLogHttp.js';

const t = await setupActivityLogHttp();

let token;
beforeEach(async () => {
  t.reset();
  token = await t.tokenFor('ADMIN');
});

const detail = (id) => t.send('get', `${API}/${id}`, token);
const oid = () => new mongoose.Types.ObjectId();

describe('a known entry', () => {
  test('has every list field plus changes, metadata and user agent', async () => {
    const car = oid();
    const actor = oid();
    const entry = t.fake.addLog({
      eventType: 'CAR_PRICE_UPDATED', performedBy: actor, performedByEmail: 'admin@trustcar.vn', targetModel: 'Car', targetId: car,
      targetCode: 'TC-2026-0001', summary: 'Price changed', ipAddress: '10.0.0.1', userAgent: 'Mozilla/5.0',
      changes: { before: { price: 100 }, after: { price: 120 } }, metadata: { reason: 'market' },
    });
    const res = await detail(entry._id);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      id: String(entry._id),
      eventType: 'CAR_PRICE_UPDATED',
      actor: { id: String(actor), email: 'admin@trustcar.vn' },
      target: { model: 'Car', id: String(car), code: 'TC-2026-0001' },
      summary: 'Price changed',
      ipAddress: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
      changes: { before: { price: 100 }, after: { price: 120 } },
      metadata: { reason: 'market' },
    });
    expect(JSON.stringify(res.body.data)).not.toMatch(/"_id"|__v/);
  });

  test('an entry with no changes, metadata or user agent returns nulls', async () => {
    const entry = t.fake.addLog({ eventType: 'USER_LOGOUT' });
    const res = await detail(entry._id);
    expect(res.status).toBe(200);
    expect(res.body.data.changes).toBeNull();
    expect(res.body.data.metadata).toBeNull();
    expect(res.body.data.userAgent).toBeNull();
    expect(res.body.data.actor).toEqual({ id: null, email: null });
  });

  test('works with the id in upper case', async () => {
    const entry = t.fake.addLog();
    expect((await detail(String(entry._id).toUpperCase())).status).toBeLessThan(500);
  });
});

describe('secret-like values are hidden, the stored entry is not touched', () => {
  test('password and token keys at any depth show "[hidden]"; everything else is intact', async () => {
    const entry = t.fake.addLog({
      eventType: 'USER_UPDATED',
      changes: {
        before: { fullName: 'A', password: 'old-secret' },
        after: { fullName: 'B', email: 'b@x.vn', password: 'new-secret', profile: { accessToken: 'abc', phone: '0901234567' } },
      },
      metadata: { tokens: [{ refreshToken: 'y' }], sessions: [{ refreshToken: 'z', ip: '1.2.3.4' }], note: 'keep me' },
    });
    const res = await detail(entry._id);

    expect(res.body.data.changes).toEqual({
      before: { fullName: 'A', password: '[hidden]' },
      after: { fullName: 'B', email: 'b@x.vn', password: '[hidden]', profile: { accessToken: '[hidden]', phone: '0901234567' } },
    });
    expect(res.body.data.metadata).toEqual({ tokens: '[hidden]', sessions: [{ refreshToken: '[hidden]', ip: '1.2.3.4' }], note: 'keep me' });
    const text = JSON.stringify(res.body);
    for (const secret of ['old-secret', 'new-secret', 'abc', '"y"', '"z"']) expect(text).not.toContain(secret);

    // the stored entry is exactly as it was
    expect(entry.changes.after.password).toBe('new-secret');
    expect(entry.metadata.tokens[0].refreshToken).toBe('y');
  });

  test('email and phone are shown as stored (the admin decision: no masking)', async () => {
    const entry = t.fake.addLog({ changes: { before: null, after: { email: 'khach@gmail.com', phone: '0901234567' } } });
    const res = await detail(entry._id);
    expect(res.body.data.changes.after).toEqual({ email: 'khach@gmail.com', phone: '0901234567' });
  });
});

describe('errors', () => {
  test('an id in the wrong format is 422 (the shared id validator answers INVALID_OBJECT_ID, like every other /:id route)', async () => {
    const res = await detail('not-an-object-id');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_OBJECT_ID');
    expect(res.body.success).toBe(false);
  });

  test('a valid id that is not in the log is 404 ACTIVITY_LOG_NOT_FOUND', async () => {
    t.fake.addLog();
    const res = await detail(oid());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ACTIVITY_LOG_NOT_FOUND');
    expect(res.body.success).toBe(false);
  });

  test('reading never writes and never logs the read', async () => {
    const entry = t.fake.addLog({ changes: { before: null, after: { a: 1 } } });
    t.h.logs.length = 0;
    await detail(entry._id);
    await detail(oid());
    expect(t.fake.writes.count).toBe(0);
    expect(t.h.logs).toHaveLength(0);
  });
});
