/**
 * @file test-drive-routes.test.js
 * @description The test-drive API end to end: real app, routes, Joi, middleware,
 * controllers and services on the in-memory harness.
 */

import request from 'supertest';
import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { default: mongoose } = await import('mongoose');

const BASE = '/api/v1/test-drives';
const FUTURE_DATE = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
const toDate = (d) => d.toISOString().slice(0, 10);

let phoneCounter = 0;
const nextPhone = () => { phoneCounter += 1; return `09${String(10000000 + phoneCounter)}`; };

let customer;
let sales;
let admin;
let carId;
let date;
let slot;

/** A customer account with a complete profile. */
const loginCustomer = async () => {
  const phone = nextPhone();
  const profile = await h.createCustomer({ phone, email: `c${phone}@trustcar.vn` });
  return { ...(await h.loginAs('CUSTOMER', { customer: profile, phone })), profile };
};

const api = () => request(h.app);
const asUser = (req, user) => req.set('Authorization', user.auth);

/** The first open weekday slot ahead, so the tests do not depend on today's date. */
const firstOpenSlot = async () => {
  for (let i = 0; i < 7; i += 1) {
    const day = toDate(new Date(FUTURE_DATE.getTime() + i * 24 * 60 * 60 * 1000));
    const res = await asUser(api().get(`${BASE}/cars/${carId}/slots`).query({ date: day }), customer);
    if (res.body.data.length) return { day, first: res.body.data[0] };
  }
  throw new Error('No open slot found');
};

beforeEach(async () => {
  h.reset();
  carId = h.createCar();
  customer = await loginCustomer();
  sales = await h.loginAs('SALES_STAFF');
  admin = await h.loginAs('ADMIN');
  const open = await firstOpenSlot();
  date = open.day;
  slot = open.first;
});

const bookIt = (user = customer, body = {}) =>
  asUser(api().post(BASE), user).send({ carId, scheduledAt: slot.startAt, ...body });

describe('access', () => {
  test('no token gives 401 everywhere', async () => {
    await api().get(`${BASE}/me`).expect(401);
    await api().post(BASE).send({}).expect(401);
    await api().get(BASE).expect(401);
  });

  test('a customer cannot use staff routes', async () => {
    await asUser(api().get(BASE), customer).expect(403);
    const id = new mongoose.Types.ObjectId();
    await asUser(api().post(`${BASE}/${id}/confirm`), customer).expect(403);
    await asUser(api().post(`${BASE}/${id}/correct-no-show`), customer).send({ outcome: 'x' }).expect(403);
  });

  test('staff cannot book and only an admin corrects a no-show', async () => {
    await bookIt(sales).expect(403);
    await asUser(api().get(`${BASE}/me`), sales).expect(403);
    await asUser(api().post(`${BASE}/${new mongoose.Types.ObjectId()}/correct-no-show`), sales).send({ outcome: 'x' }).expect(403);
  });

  test('an incomplete customer profile is refused', async () => {
    const incomplete = await h.loginAs('CUSTOMER', { password: null, firebaseUid: 'google-only-account' });
    const res = await bookIt(incomplete).expect(403);
    expect(res.body.code).toBe('PROFILE_INCOMPLETE');
  });

  test('only an admin can change the showroom settings', async () => {
    await asUser(api().put('/api/v1/admin/base-settings'), sales).send({}).expect(403);
    await asUser(api().put('/api/v1/admin/base-settings'), customer).send({}).expect(403);
  });

  test('removed features have no routes', async () => {
    await asUser(api().post(`${BASE}/staff-booking`), sales).send({}).expect(404);
    await asUser(api().post(`${BASE}/${new mongoose.Types.ObjectId()}/attendance`), sales).expect(404);
    await api().get('/api/v1/public/test-drives/respond').expect(404);
  });
});

describe('validation', () => {
  test.each([
    ['a bad car id', { carId: 'abc' }],
    ['a time without an offset', { scheduledAt: '2030-01-15T09:00:00' }],
  ])('booking with %s gives 422', async (_name, body) => {
    const res = await bookIt(customer, body).expect(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('a customer cannot choose the staff member, status or seat', async () => {
    const chosen = new mongoose.Types.ObjectId().toString();
    const res = await bookIt(customer, { assignedTo: chosen, status: 'CONFIRMED', slotSeat: 99 }).expect(201);
    const stored = h.appointment(res.body.data.id);
    expect(String(stored.assignedTo)).not.toBe(chosen);
    expect(stored.status).toBe('PENDING');
    expect(stored.slotSeat).toBe(1);
  });

  test('slots need a real date', async () => {
    await asUser(api().get(`${BASE}/cars/${carId}/slots`).query({ date: '2030-02-31' }), customer).expect(422);
    await asUser(api().get(`${BASE}/cars/${carId}/slots`), customer).expect(422);
  });

  test('staff cancel requires a reason, and a note for OTHER', async () => {
    const id = new mongoose.Types.ObjectId();
    await asUser(api().post(`${BASE}/${id}/staff-cancel`), sales).send({}).expect(422);
    await asUser(api().post(`${BASE}/${id}/staff-cancel`), sales).send({ reasonCode: 'OTHER' }).expect(422);
  });

  test('complete requires an outcome', async () => {
    await asUser(api().post(`${BASE}/${new mongoose.Types.ObjectId()}/complete`), sales).send({}).expect(422);
  });
});

describe('customer flow', () => {
  test('sees slots with offsets, books, lists, cancels, and the slot is free again', async () => {
    const before = await asUser(api().get(`${BASE}/cars/${carId}/slots`).query({ date }), customer).expect(200);
    expect(before.body.data[0]).toEqual({ startAt: slot.startAt, endAt: slot.endAt, available: true });

    const booked = await bookIt().expect(201);
    expect(booked.body.data.status).toBe('PENDING');
    expect(booked.body.data).not.toHaveProperty('assignedTo');

    const taken = await asUser(api().get(`${BASE}/cars/${carId}/slots`).query({ date }), customer).expect(200);
    expect(taken.body.data[0].available).toBe(false);

    const mine = await asUser(api().get(`${BASE}/me`), customer).expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).not.toHaveProperty('assignedTo');
    expect(mine.body.data[0]).not.toHaveProperty('createdBy');

    await asUser(api().post(`${BASE}/${booked.body.data.id}/cancel`), customer).expect(200);

    const free = await asUser(api().get(`${BASE}/cars/${carId}/slots`).query({ date }), customer).expect(200);
    expect(free.body.data[0].available).toBe(true);
  });

  test('a taken car returns alternatives in the error body', async () => {
    await bookIt().expect(201);
    const res = await bookIt(await loginCustomer()).expect(409);
    expect(res.body.code).toBe('CAR_SLOT_TAKEN');
    expect(res.body.errors.nearestSlots.length).toBeGreaterThan(0);
  });

  test("another customer's appointment reads as 404", async () => {
    const booked = await bookIt().expect(201);
    const res = await asUser(api().post(`${BASE}/${booked.body.data.id}/cancel`), await loginCustomer()).expect(404);
    expect(res.body.code).toBe('TEST_DRIVE_NOT_FOUND');
  });

  test('the 11th booking request in the window gives 429', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await bookIt(customer, { carId: 'bad' })).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 422)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('staff flow', () => {
  test('lists, confirms, reassigns, cancels with a reason the customer can read', async () => {
    const booked = await bookIt().expect(201);
    const { id } = booked.body.data;

    const list = await asUser(api().get(BASE).query({ status: 'PENDING', date }), sales).expect(200);
    expect(list.body.data.map((a) => a.id)).toEqual([id]);

    await asUser(api().post(`${BASE}/${id}/confirm`), sales).expect(200);
    await asUser(api().post(`${BASE}/${id}/confirm`), sales).expect(409);
    await asUser(api().post(`${BASE}/${id}/complete`), sales).send({ outcome: 'x' }).expect(409);

    const other = (await h.createUser({ roleName: 'SALES_STAFF' })).id;
    await asUser(api().patch(`${BASE}/${id}/assign`), admin).send({ staffId: other }).expect(200);

    await asUser(api().post(`${BASE}/${id}/staff-cancel`), sales).send({ reasonCode: 'SLOT_FULL' }).expect(200);

    const mine = await asUser(api().get(`${BASE}/me`), customer).expect(200);
    expect(mine.body.data[0]).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Khung giờ đã hết chỗ' });
  });

  test('needsAttention arrives as a boolean filter', async () => {
    await bookIt().expect(201);
    const res = await asUser(api().get(BASE).query({ needsAttention: 'true' }), sales).expect(200);
    expect(res.body.data).toEqual([]);
  });

  test('an unknown appointment gives 404', async () => {
    await asUser(api().post(`${BASE}/${new mongoose.Types.ObjectId()}/confirm`), sales).expect(404);
  });
});
