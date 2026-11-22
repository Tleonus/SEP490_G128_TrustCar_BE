/**
 * @file activity-log-harness.test.js
 * @description KAN-40: the in-memory ActivityLog stand-in behaves like MongoDB for what the admin
 * endpoints use, so the other activity-log tests can be trusted.
 */

import mongoose from 'mongoose';
import ActivityLog from '../src/models/ActivityLog.js';
import { setupActivityLogFake } from './helpers/fakeActivityLogModel.js';
import { buildFilter } from '../src/services/activityLogFilter.js';

const fake = await setupActivityLogFake(ActivityLog);
beforeEach(() => fake.reset());

const oid = () => new mongoose.Types.ObjectId();

describe('find / countDocuments', () => {
  test('equality, ObjectId and Date range filters', async () => {
    const car = oid();
    fake.addLog({ eventType: 'CAR_CREATED', targetId: car, createdAt: new Date('2026-11-10T00:00:00Z') });
    fake.addLog({ eventType: 'CAR_UPDATED', targetId: car, createdAt: new Date('2026-11-12T00:00:00Z') });
    fake.addLog({ eventType: 'CAR_UPDATED', targetId: oid(), createdAt: new Date('2026-11-14T00:00:00Z') });

    expect(await ActivityLog.find({ eventType: 'CAR_UPDATED' })).toHaveLength(2);
    expect(await ActivityLog.find({ targetId: car })).toHaveLength(2);
    expect(await ActivityLog.find({ targetId: new mongoose.Types.ObjectId(String(car)) })).toHaveLength(2);
    expect(await ActivityLog.countDocuments({ createdAt: { $gte: new Date('2026-11-11T00:00:00Z'), $lt: new Date('2026-11-14T00:00:00Z') } })).toBe(1);
    expect(await ActivityLog.countDocuments({})).toBe(3);
  });

  test('RegExp values match strings only, case flag honoured, null never matches', async () => {
    fake.addLog({ performedByEmail: 'admin@trustcar.vn' });
    fake.addLog({ performedByEmail: 'ADMIN@TRUSTCAR.VN' });
    fake.addLog({ performedByEmail: 'other@trustcar.vn' });
    fake.addLog({ performedByEmail: null });

    expect(await ActivityLog.countDocuments({ performedByEmail: /^admin@trustcar\.vn$/i })).toBe(2);
    expect(await ActivityLog.countDocuments({ performedByEmail: /^admin@trustcar\.vn$/ })).toBe(1);
    expect(await ActivityLog.countDocuments({ performedByEmail: /.*/ })).toBe(3);
  });

  test('works with the real filter builder', async () => {
    fake.addLog({ eventType: 'USER_LOGIN', performedByEmail: 'a@x.vn', createdAt: new Date('2026-11-14T17:30:00Z') });
    fake.addLog({ eventType: 'USER_LOGIN', performedByEmail: 'a@x.vn', createdAt: new Date('2026-11-13T17:30:00Z') });
    const filter = buildFilter({ eventType: 'USER_LOGIN', actorEmail: 'A@X.VN', from: '2026-11-15', to: '2026-11-15' });
    expect(await ActivityLog.find(filter)).toHaveLength(1);
  });
});

describe('sort / skip / limit / lean', () => {
  test('sorts by several keys and breaks ties by _id in the same direction', async () => {
    const same = new Date('2026-11-10T00:00:00Z');
    const a = fake.addLog({ createdAt: same });
    const b = fake.addLog({ createdAt: same });
    const c = fake.addLog({ createdAt: new Date('2026-11-11T00:00:00Z') });

    const desc = await ActivityLog.find({}).sort({ createdAt: -1, _id: -1 }).lean();
    expect(desc.map((d) => String(d._id))).toEqual([c, b, a].map((d) => String(d._id)));
    const asc = await ActivityLog.find({}).sort({ createdAt: 1, _id: 1 }).lean();
    expect(asc.map((d) => String(d._id))).toEqual([a, b, c].map((d) => String(d._id)));
  });

  test('paginates with skip and limit', async () => {
    for (let i = 0; i < 45; i += 1) fake.addLog();
    const page3 = await ActivityLog.find({}).sort({ createdAt: -1 }).skip(40).limit(20).lean();
    expect(page3).toHaveLength(5);
  });

  test('returns copies, so a caller cannot change the stored rows', async () => {
    fake.addLog({ changes: { before: null, after: { price: 1 } } });
    const [row] = await ActivityLog.find({}).lean();
    row.changes.after.price = 999;
    expect(fake.rows[0].changes.after.price).toBe(1);
  });
});

describe('findById / distinct', () => {
  test('findById finds by ObjectId or its string, null when absent', async () => {
    const doc = fake.addLog({ eventType: 'CAR_CREATED' });
    expect((await ActivityLog.findById(doc._id).lean()).eventType).toBe('CAR_CREATED');
    expect((await ActivityLog.findById(String(doc._id)).lean())._id).toEqual(doc._id);
    expect(await ActivityLog.findById(oid()).lean()).toBeNull();
  });

  test('distinct returns each value once, like MongoDB (null included)', async () => {
    fake.addLog({ targetModel: 'Car' });
    fake.addLog({ targetModel: 'Car' });
    fake.addLog({ targetModel: 'User' });
    fake.addLog({ targetModel: null });
    expect((await ActivityLog.distinct('targetModel')).sort()).toEqual([null, 'Car', 'User'].sort());
  });
});

describe('guards', () => {
  test('every write method throws and is counted', () => {
    expect(() => ActivityLog.create({})).toThrow(/must not be called/);
    expect(() => ActivityLog.deleteMany({})).toThrow(/must not be called/);
    expect(() => ActivityLog.updateOne({}, {})).toThrow(/must not be called/);
    expect(fake.writes.count).toBe(3);
    expect(fake.writes.calls).toEqual(['create', 'deleteMany', 'updateOne']);
  });

  test('reads are counted so a test can prove "zero queries"', async () => {
    expect(fake.reads.count).toBe(0);
    await ActivityLog.find({});
    await ActivityLog.countDocuments({});
    expect(fake.reads.count).toBe(2);
  });

  test('reset empties everything', async () => {
    fake.addLog();
    await ActivityLog.find({});
    fake.reset();
    expect(fake.rows).toHaveLength(0);
    expect(fake.reads.count).toBe(0);
  });
});
