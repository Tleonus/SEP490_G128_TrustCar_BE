/**
 * @file activity-log-mapper.test.js
 * @description KAN-40: allow-list DTOs and the secret-hiding walk of the activity-log detail.
 *
 * Ref: .sdd/features/system-audit-logs/SPEC.md (REQ-007, REQ-008, REQ-012; AC-11…14, AC-20)
 */

import mongoose from 'mongoose';
import { hideSecrets, HIDDEN, toDetail, toListItem } from '../src/services/activityLogMapper.js';

const oid = () => new mongoose.Types.ObjectId();
const doc = (extra = {}) => ({
  _id: oid(),
  __v: 0,
  eventType: 'CAR_PRICE_UPDATED',
  performedBy: oid(),
  performedByEmail: 'admin@trustcar.vn',
  targetModel: 'Car',
  targetId: oid(),
  targetCode: 'TC-2026-0001',
  summary: 'Price changed',
  ipAddress: '10.0.0.1',
  userAgent: 'Mozilla/5.0',
  changes: { before: { price: 1 }, after: { price: 2 } },
  metadata: { reason: 'market' },
  createdAt: new Date('2026-11-15T03:00:00Z'),
  ...extra,
});

describe('toListItem: allow-list of the list row', () => {
  test('returns exactly the documented fields', () => {
    const d = doc();
    const item = toListItem(d);
    expect(Object.keys(item).sort()).toEqual(['action', 'actor', 'createdAt', 'eventType', 'id', 'ipAddress', 'summary', 'target'].sort());
    expect(item).toEqual({
      id: String(d._id),
      eventType: 'CAR_PRICE_UPDATED',
      action: 'UPDATE',
      createdAt: d.createdAt,
      actor: { id: String(d.performedBy), email: 'admin@trustcar.vn' },
      target: { model: 'Car', id: String(d.targetId), code: 'TC-2026-0001' },
      summary: 'Price changed',
      ipAddress: '10.0.0.1',
    });
  });

  test('never exposes changes, metadata, user agent, _id or __v', () => {
    const item = toListItem(doc());
    for (const key of ['changes', 'metadata', 'userAgent', '_id', '__v', 'performedBy', 'performedByEmail']) {
      expect(item).not.toHaveProperty(key);
    }
  });

  test('a system action has an actor object with null id and email', () => {
    const item = toListItem(doc({ performedBy: null, performedByEmail: undefined }));
    expect(item.actor).toEqual({ id: null, email: null });
  });

  test('missing optional fields become null, the objects stay objects', () => {
    const item = toListItem({ _id: oid(), eventType: 'USER_LOGIN', createdAt: new Date() });
    expect(item.actor).toEqual({ id: null, email: null });
    expect(item.target).toEqual({ model: null, id: null, code: null });
    expect(item.summary).toBeNull();
    expect(item.ipAddress).toBeNull();
  });

  test('ids are plain strings', () => {
    const item = toListItem(doc());
    expect(typeof item.id).toBe('string');
    expect(typeof item.actor.id).toBe('string');
    expect(typeof item.target.id).toBe('string');
  });
});

describe('toDetail', () => {
  test('adds changes, metadata and user agent to the list row', () => {
    const d = doc();
    const detail = toDetail(d);
    expect(detail).toMatchObject(toListItem(d));
    expect(detail.changes).toEqual({ before: { price: 1 }, after: { price: 2 } });
    expect(detail.metadata).toEqual({ reason: 'market' });
    expect(detail.userAgent).toBe('Mozilla/5.0');
    expect(detail).not.toHaveProperty('_id');
    expect(detail).not.toHaveProperty('__v');
  });

  test('no changes, no metadata, no user agent give nulls', () => {
    const detail = toDetail(doc({ changes: null, metadata: null, userAgent: undefined }));
    expect(detail.changes).toBeNull();
    expect(detail.metadata).toBeNull();
    expect(detail.userAgent).toBeNull();
  });

  test('a one-sided change keeps the missing side as null', () => {
    expect(toDetail(doc({ changes: { after: { a: 1 } } })).changes).toEqual({ before: null, after: { a: 1 } });
  });

  test('hides secret-like values in changes and metadata, leaves the rest', () => {
    const detail = toDetail(doc({
      changes: { before: null, after: { email: 'a@b.vn', password: 'p4ss', nested: { accessToken: 'abc', ok: 1 } } },
      metadata: { tokens: [{ refreshToken: 'y' }], note: 'keep me' },
    }));
    expect(detail.changes.after).toEqual({ email: 'a@b.vn', password: HIDDEN, nested: { accessToken: HIDDEN, ok: 1 } });
    expect(detail.metadata).toEqual({ tokens: HIDDEN, note: 'keep me' });
  });

  test('does not modify the stored document', () => {
    const d = doc({ changes: { before: null, after: { password: 'p4ss' } } });
    toDetail(d);
    expect(d.changes.after.password).toBe('p4ss');
  });
});

describe('hideSecrets', () => {
  test.each([
    ['password'], ['Password'], ['newPassword'], ['passwordHash'], ['refreshToken'], ['accessToken'], ['token'],
    ['clientSecret'], ['hash'], ['Authorization'], ['apiKey'], ['api_key'], ['api-key'], ['pass'],
  ])('hides the value of "%s"', (key) => {
    expect(hideSecrets({ [key]: 'x', other: 'y' })).toEqual({ [key]: HIDDEN, other: 'y' });
  });

  test('hides whatever type the value is (string, number, object, array, null)', () => {
    expect(hideSecrets({ password: 123, token: { a: 1 }, secret: [1, 2], hash: null }))
      .toEqual({ password: HIDDEN, token: HIDDEN, secret: HIDDEN, hash: HIDDEN });
  });

  test('walks nested objects and arrays', () => {
    const input = { users: [{ name: 'a', credentials: { password: 'p' } }, { name: 'b', sessions: [{ refreshToken: 'r', ip: '1' }] }] };
    expect(hideSecrets(input)).toEqual({
      users: [{ name: 'a', credentials: { password: HIDDEN } }, { name: 'b', sessions: [{ refreshToken: HIDDEN, ip: '1' }] }],
    });
  });

  test('keeps primitives, null and undefined as they are', () => {
    expect(hideSecrets('text')).toBe('text');
    expect(hideSecrets(5)).toBe(5);
    expect(hideSecrets(null)).toBeNull();
    expect(hideSecrets(undefined)).toBeUndefined();
  });

  test('does not walk into ObjectId or Date values', () => {
    const id = oid();
    const when = new Date('2026-11-15T00:00:00Z');
    const out = hideSecrets({ ref: id, at: when, list: [id, when] });
    expect(out.ref).toBe(id);
    expect(out.at).toBe(when);
    expect(out.list[0]).toBe(id);
    expect(out.list[1]).toBe(when);
  });

  test('never modifies its input', () => {
    const input = { password: 'p', nested: { token: 't', keep: [1, { secret: 's' }] } };
    const snapshot = JSON.parse(JSON.stringify(input));
    hideSecrets(input);
    expect(input).toEqual(snapshot);
  });

  test('a harmless key that merely contains a secret-like word is hidden too (deliberately over-cautious)', () => {
    expect(hideSecrets({ hashtag: '#x', tokenCount: 3 })).toEqual({ hashtag: HIDDEN, tokenCount: HIDDEN });
  });

  test('a very deep document is cut instead of recursing without end', () => {
    let deep = { leaf: 'x' };
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    const out = hideSecrets(deep);
    let cursor = out;
    let levels = 0;
    while (cursor && typeof cursor === 'object' && cursor.child !== undefined) { cursor = cursor.child; levels += 1; }
    expect(levels).toBeLessThanOrEqual(13);
    expect(cursor).toBe('[too deep]');
  });

  test('objects without a prototype are walked as plain objects', () => {
    const bare = Object.assign(Object.create(null), { password: 'p', ok: 1 });
    expect(hideSecrets(bare)).toEqual({ password: HIDDEN, ok: 1 });
  });
});
