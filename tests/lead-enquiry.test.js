/**
 * @file lead-enquiry.test.js
 * @description POST /api/v1/leads — the endpoint the public contact form and the
 * car-detail "Yêu cầu tư vấn" modal both call. Before KAN-48 that route did not
 * exist, so every enquiry returned 404 and no lead was ever recorded.
 *
 * Runs the real app (routes → middleware → controller → service) on the
 * in-memory auth harness. Only Lead persistence and the Car lookup are faked.
 *
 * Ref: KAN-48
 */

import mongoose from 'mongoose';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
// Loaded after the harness on purpose: importing it first would bind the harness's
// jest.unstable_mockModule paths to this file instead of tests/helpers.
const { jest } = await import('@jest/globals');

const { default: Lead }   = await import('../src/models/Lead.js');
const { default: Car }    = await import('../src/models/Car.js');
const { signAccessToken } = await import('../src/utils/authTokens.js');

const URL = '/api/v1/leads';

// ── In-memory Lead collection + Car stand-in ───────────────────────────────
let leads         = [];
let createCalls   = [];
let carDoc        = null;
let duplicateOnce = false;

const resetStore = () => {
  leads         = [];
  createCalls   = [];
  carDoc        = null;
  duplicateOnce = false;
};

/** The highest LD-NNNN already stored, the way generateLeadCode finds it. */
const highestLeadCode = () => leads.reduce((max, l) => {
  const n = parseInt(String(l.leadCode).split('-')[1], 10);
  const m = parseInt(String(max).split('-')[1], 10);
  return Number.isNaN(n) || n <= m ? max : l.leadCode;
}, 'LD-0000');

const leadQuery = (value) => {
  const q = {
    select: () => q, populate: () => q, sort: () => q, skip: () => q, limit: () => q,
    lean:   () => q,
    then:   (ok, ko) => Promise.resolve(value).then(ok, ko),
  };
  return q;
};

jest.spyOn(Lead, 'create').mockImplementation(async (data) => {
  createCalls.push(data);

  if (duplicateOnce) {
    duplicateOnce = false;
    throw Object.assign(new Error('E11000 duplicate key error collection: leads index: leadCode_1'), {
      name: 'MongoServerError', code: 11000, keyPattern: { leadCode: 1 }, keyValue: { leadCode: data.leadCode },
    });
  }

  const doc = new Lead(data);
  await doc.validate();                 // real schema rules: customer required, enums, maxlength
  if (!doc.createdAt) doc.createdAt = new Date();
  leads.push(doc);
  return doc;
});

jest.spyOn(Lead, 'findOne').mockImplementation((filter = {}) => {
  if (filter.leadCode?.$regex) {
    // generateLeadCode(): read the highest existing code
    return leadQuery(leads.length ? { leadCode: highestLeadCode() } : null);
  }
  const hit = leads.find((l) =>
    (!filter._id      || String(l._id) === String(filter._id)) &&
    (!filter.leadCode || l.leadCode === filter.leadCode)) || null;
  return leadQuery(hit);
});
jest.spyOn(Lead, 'countDocuments').mockImplementation(async () => leads.length);
jest.spyOn(Lead, 'find').mockImplementation(() => leadQuery(leads));

jest.spyOn(Car, 'findOne').mockImplementation(() => leadQuery(carDoc));

const tokenFor = async (roleName) => {
  const { id } = await h.createUser({ roleName });
  return signAccessToken(await h.User.findById(id).select('+tokenVersion'));
};

/** A visitor's request: no token, its own IP so the enquiry limiter never trips. */
const submit = (body, ip = h.nextIp()) =>
  request(h.app).post(URL).set('X-Forwarded-For', ip).send(body);

beforeEach(() => {
  h.reset();
  resetStore();
});

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/leads — public intake', () => {

  test('the contact-form payload creates a lead and returns its code', async () => {
    const res = await submit({
      full_name:       'Nguyễn Văn A',
      phone_number:    '0901234567',
      email:           'a@example.com',
      request_content: 'Tôi muốn hỏi về xe Hyundai Tucson.',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.leadCode).toBe('LD-0001');
    expect(res.body.message).toContain('LD-0001');

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      stage:     'NEW',
      car:       null,
      createdBy: null,
      source:    'Website — Contact Form',
    });
    expect(createCalls[0].enquiry).toMatchObject({
      message:        'Tôi muốn hỏi về xe Hyundai Tucson.',
      submittedName:  'Nguyễn Văn A',
      submittedPhone: '0901234567',
      submittedEmail: 'a@example.com',
    });
  });

  test('the car-detail modal payload attaches the vehicle to the lead', async () => {
    carDoc = { _id: new mongoose.Types.ObjectId(), vehicleCode: 'TC-2026-0001', status: 'AVAILABLE' };

    const res = await submit({
      vehicleCode:     'TC-2026-0001',
      full_name:       'Trần Thị B',
      phone_number:    '0912345678',
      request_content: 'Tôi muốn xem xe này vào cuối tuần.',
    });

    expect(res.status).toBe(201);
    expect(String(createCalls[0].car)).toBe(String(carDoc._id));
    expect(createCalls[0].source).toBe('Website — Vehicle Enquiry');
  });

  test('a sold vehicle is refused with 404 rather than attached to the lead', async () => {
    carDoc = { _id: new mongoose.Types.ObjectId(), vehicleCode: 'TC-2026-0002', status: 'SOLD' };

    const res = await submit({
      full_name:       'Trần Thị B',
      phone_number:    '0912345678',
      request_content: 'Xe này còn không?',
      vehicleCode:     'TC-2026-0002',
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CAR_NOT_FOUND');
    expect(createCalls).toHaveLength(0);
    expect(h.customers.size).toBe(0);
  });

  test('a +84 phone number is normalized to the 10-digit form', async () => {
    const res = await submit({
      full_name:       'Lê Văn C',
      phone_number:    '+84912345678',
      request_content: 'Cần tư vấn.',
    });

    expect(res.status).toBe(201);
    expect(createCalls[0].enquiry.submittedPhone).toBe('0912345678');
  });

  test('the same phone twice reuses the customer and opens a second lead', async () => {
    const body = { full_name: 'Phạm Thị D', phone_number: '0961234567', request_content: 'Hỏi giá.' };

    await submit(body);
    await submit(body);

    expect(h.customers.size).toBe(1);
    expect(createCalls).toHaveLength(2);
    expect(String(createCalls[1].customer)).toBe(String(createCalls[0].customer));
    expect(leads.map((l) => l.leadCode)).toEqual(['LD-0001', 'LD-0002']);
  });

  test('two different visitors become two customers', async () => {
    await submit({ full_name: 'Khách Một', phone_number: '0901111111', request_content: 'A' });
    await submit({ full_name: 'Khách Hai', phone_number: '0902222222', request_content: 'B' });

    expect(h.customers.size).toBe(2);
  });

  test('a duplicate leadCode is retried instead of failing the request', async () => {
    duplicateOnce = true;

    const res = await submit({ full_name: 'Hoàng Văn E', phone_number: '0971234567', request_content: 'C' });

    expect(res.status).toBe(201);
    expect(createCalls).toHaveLength(2);
    expect(leads).toHaveLength(1);
  });

  test('the camelCase spelling of the same payload is also accepted', async () => {
    const res = await submit({
      fullName: 'Vũ Văn H',
      phone_number: '0931234567',
      message:  'Cần báo giá xe.',
    });

    expect(res.status).toBe(201);
    expect(createCalls[0].enquiry).toMatchObject({
      submittedName: 'Vũ Văn H',
      message:       'Cần báo giá xe.',
    });
  });

  test('an audit entry is written for every enquiry', async () => {
    await submit({ full_name: 'Đỗ Thị F', phone_number: '0981234567', request_content: 'D' });

    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({
      eventType:   'LEAD_CREATED',
      targetModel: 'Lead',
      performedBy: null,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/v1/leads — bad input is rejected before anything is written', () => {

  test.each([
    ['malformed phone number', { full_name: 'An', phone_number: '12345',      request_content: 'x' }],
    ['missing phone number',   { full_name: 'An',                             request_content: 'x' }],
    ['missing name',           { phone_number: '0901234567',                  request_content: 'x' }],
    ['missing message',        { full_name: 'An', phone_number: '0901234567' }],
    ['unknown field',          { full_name: 'An', phone_number: '0901234567', request_content: 'x', isAdmin: true }],
  ])('%s → 422 VALIDATION_ERROR', async (_label, body) => {
    const res = await submit(body);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(createCalls).toHaveLength(0);
    expect(h.customers.size).toBe(0);
  });

  test('an unknown vehicle code → 404 CAR_NOT_FOUND, no lead and no customer', async () => {
    carDoc = null;

    const res = await submit({
      full_name:       'Ngô Văn G',
      phone_number:    '0901234567',
      request_content: 'Xe này còn không?',
      vehicleCode:     'TC-2026-9999',
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CAR_NOT_FOUND');
    expect(createCalls).toHaveLength(0);
    expect(h.customers.size).toBe(0);
  });

  test('the limiter stops the 6th enquiry from one IP with 429', async () => {
    const ip   = h.nextIp();
    const body = { full_name: 'Spam Bot', phone_number: '0909999999', request_content: 'spam' };

    for (let i = 0; i < 5; i += 1) {
      const ok = await submit(body, ip);
      expect(ok.status).toBe(201);
    }

    const blocked = await submit(body, ip);

    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('ENQUIRY_RATE_LIMIT');
    expect(createCalls).toHaveLength(5);
  });

  test('the limiter does not block enquiries from a different IP', async () => {
    const body = { full_name: 'Spam Bot', phone_number: '0909999999', request_content: 'spam' };

    for (let i = 0; i < 5; i += 1) await submit(body, h.nextIp());
    const other = await submit(body, h.nextIp());

    expect(other.status).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('GET /api/v1/leads — staff pipeline', () => {

  test.each(['ADMIN', 'SALES_STAFF'])('%s can read the pipeline', async (roleName) => {
    const res = await request(h.app)
      .get(URL)
      .set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${await tokenFor(roleName)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  test('a lead written by the public form shows up in the pipeline', async () => {
    await submit({ full_name: 'Nguyễn Văn A', phone_number: '0901234567', request_content: 'Hỏi xe' });

    const res = await request(h.app)
      .get(URL)
      .set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${await tokenFor('SALES_STAFF')}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].leadCode).toBe('LD-0001');
    expect(res.body.meta.total).toBe(1);
  });

  test.each(['CUSTOMER'])('%s gets 403', async (roleName) => {
    const res = await request(h.app)
      .get(URL)
      .set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${await tokenFor(roleName)}`);

    expect(res.status).toBe(403);
  });

  test('no token → 401', async () => {
    const res = await request(h.app).get(URL).set('X-Forwarded-For', h.nextIp());

    expect(res.status).toBe(401);
  });

  test('an out-of-range limit → 422', async () => {
    const res = await request(h.app)
      .get(`${URL}?limit=500`)
      .set('X-Forwarded-For', h.nextIp())
      .set('Authorization', `Bearer ${await tokenFor('ADMIN')}`);

    expect(res.status).toBe(422);
  });
});
