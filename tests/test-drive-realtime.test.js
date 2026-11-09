/**
 * @file test-drive-realtime.test.js
 * @description Realtime test-drive notifications with a real client over a temporary
 * port. Persistence is the in-memory harness, so no MongoDB is involved.
 */

import http from 'node:http';
import jwt from 'jsonwebtoken';
import { io as connectClient } from 'socket.io-client';
import { setupTestDriveHarness } from './helpers/fakeTestDriveModels.js';

const h = await setupTestDriveHarness();
const { jest } = await import('@jest/globals');
const { default: logger } = await import('../src/utils/logger.js');
const { default: User } = await import('../src/models/User.js');
const { default: ActivityLog } = await import('../src/models/ActivityLog.js');
const { signAccessToken, signRefreshToken } = await import('../src/utils/authTokens.js');
const { getRealtime, startRealtime, stopRealtime } = await import('../src/config/realtime.js');
const { default: mongoose } = await import('mongoose');
const { bookOnline } = await import('../src/services/testDriveBookingService.js');
const staffService = await import('../src/services/testDriveStaffService.js');
const { cancelMine } = await import('../src/services/testDriveCustomerService.js');
const { cancelForUnavailableCars } = await import('../src/jobs/testDriveJob.js');
const { generateSlots, toLocalDate } = await import('../src/services/testDriveSlots.js');
const { getDefaultBaseSettings } = await import('../src/config/baseSettings.js');

let server;
let url;
const clients = [];

beforeEach(async () => {
  h.reset();
  server = http.createServer();
  startRealtime(server, { origin: '*' });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  clients.splice(0).forEach((client) => client.disconnect());
  stopRealtime();
  await new Promise((resolve) => { server.close(resolve); });
});

/** Opens a client and resolves once the server has accepted or refused it. */
const connect = (auth, extraHeaders = {}) => new Promise((resolve) => {
  const client = connectClient(url, { auth, extraHeaders, transports: ['websocket'], reconnection: false });
  clients.push(client);
  client.once('connect', () => resolve({ client, error: null }));
  client.once('connect_error', (error) => resolve({ client, error }));
});

const tokenFor = async (roleName, overrides = {}, tokenVersion = 0) => {
  const user = await h.createUser({ roleName, ...overrides });
  return { id: user.id, token: signAccessToken({ _id: user.id, email: user.email, roleName, tokenVersion }) };
};

const roomSize = async (room) => (await getRealtime().in(room).fetchSockets()).length;

describe('connecting', () => {
  test('a valid token connects', async () => {
    const { token } = await tokenFor('CUSTOMER');
    const { client, error } = await connect({ token });
    expect(error).toBeNull();
    expect(client.connected).toBe(true);
  });

  test('no token is refused', async () => {
    const { error } = await connect({});
    expect(error.message).toBe('UNAUTHORIZED');
  });

  test('a forged token is refused', async () => {
    const { id } = await tokenFor('ADMIN');
    const token = jwt.sign({ userId: id, roleName: 'ADMIN', type: 'access', tv: 0 }, 'not-the-server-secret');
    const { error } = await connect({ token });
    expect(error.message).toBe('UNAUTHORIZED');
  });

  test('an expired token is refused', async () => {
    process.env.JWT_ACCESS_EXPIRES_IN = '-1s';
    const { token } = await tokenFor('ADMIN');
    delete process.env.JWT_ACCESS_EXPIRES_IN;
    const { error } = await connect({ token });
    expect(error.message).toBe('UNAUTHORIZED');
  });

  test('a refresh token is refused', async () => {
    const user = await h.createUser({ roleName: 'ADMIN' });
    const { error } = await connect({ token: signRefreshToken({ _id: user.id, tokenVersion: 0 }) });
    expect(error.message).toBe('UNAUTHORIZED');
  });

  test('a token from before logout is refused', async () => {
    const { token } = await tokenFor('ADMIN', {}, 5);
    const { error } = await connect({ token });
    expect(error.message).toBe('UNAUTHORIZED');
  });

  test('a database failure is refused without detail and is logged', async () => {
    const { token } = await tokenFor('ADMIN');
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => {});
    User.findById.mockImplementationOnce(() => { throw new Error('db down'); });

    const { error } = await connect({ token });

    expect(error.message).toBe('UNAUTHORIZED');
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  test('a locked account is refused', async () => {
    const { token } = await tokenFor('ADMIN', { isActive: false });
    const { error } = await connect({ token });
    expect(error.message).toBe('UNAUTHORIZED');
  });
});

describe('allowed origins', () => {
  const ALLOWED = 'https://trustcar.example';
  let restricted;

  beforeEach(async () => {
    stopRealtime();
    restricted = http.createServer();
    startRealtime(restricted, { origin: [ALLOWED] });
    await new Promise((resolve) => { restricted.listen(0, '127.0.0.1', resolve); });
    url = `http://127.0.0.1:${restricted.address().port}`;
  });

  afterEach(async () => {
    clients.splice(0).forEach((client) => client.disconnect());
    stopRealtime();
    await new Promise((resolve) => { restricted.close(resolve); });
  });

  test('a page from an allowed origin connects', async () => {
    const { token } = await tokenFor('CUSTOMER');
    const { error } = await connect({ token }, { origin: ALLOWED });
    expect(error).toBeNull();
  });

  test('a page from another origin is refused over WebSocket, even with a valid token', async () => {
    const { token } = await tokenFor('CUSTOMER');
    const { error } = await connect({ token }, { origin: 'https://evil.example' });
    expect(error).not.toBeNull();
    expect(await roomSize('staff')).toBe(0);
  });

  test('a client that sends no origin connects with a valid token, as the API allows', async () => {
    const { token } = await tokenFor('CUSTOMER');
    const { error } = await connect({ token });
    expect(error).toBeNull();
  });
});

describe('groups', () => {
  test.each(['SALES_STAFF', 'ADMIN'])('%s joins the staff group', async (role) => {
    const { token } = await tokenFor(role);
    await connect({ token });
    expect(await roomSize('staff')).toBe(1);
  });

  test('the role comes from the account, not from the token', async () => {
    const user = await h.createUser({ roleName: 'CUSTOMER' });
    const token = signAccessToken({ _id: user.id, email: user.email, roleName: 'ADMIN', tokenVersion: 0 });
    await connect({ token });
    expect(await roomSize('staff')).toBe(0);
  });

  test('a customer joins only their own group', async () => {
    const customer = await h.createCustomer({ phone: '0901234567' });
    const { token } = await tokenFor('CUSTOMER', { customer, phone: '0901234567' });
    await connect({ token });
    expect(await roomSize(`customer:${customer}`)).toBe(1);
    expect(await roomSize('staff')).toBe(0);
  });

  test('a role outside the staff and customer groups joins no group', async () => {
    // KAN-54: INSPECTOR no longer exists. A CUSTOMER with no linked customer
    // record belongs to neither the staff room nor any customer room.
    const { token } = await tokenFor('CUSTOMER');
    await connect({ token });
    expect(await roomSize('staff')).toBe(0);
    expect((await getRealtime().fetchSockets()).filter((s) =>
      [...s.rooms].some((room) => room.startsWith('customer:'))).length).toBe(0);
  });
});

describe('following a day', () => {
  const DAY = '2026-11-10';
  const signedIn = async () => {
    const { token } = await tokenFor('CUSTOMER');
    return (await connect({ token })).client;
  };

  test('subscribing joins the day, unsubscribing leaves it', async () => {
    const client = await signedIn();

    await expect(client.emitWithAck('slots:subscribe', { date: DAY })).resolves.toEqual({ ok: true });
    expect(await roomSize(`slots:${DAY}`)).toBe(1);

    await expect(client.emitWithAck('slots:unsubscribe', { date: DAY })).resolves.toEqual({ ok: true });
    expect(await roomSize(`slots:${DAY}`)).toBe(0);
  });

  test.each([['2026-13-40'], ['abc'], [''], [20261110], [null]])('date %p is refused and the connection stays', async (date) => {
    const client = await signedIn();

    await expect(client.emitWithAck('slots:subscribe', { date })).resolves.toEqual({ ok: false, code: 'VALIDATION_ERROR' });
    expect(client.connected).toBe(true);
    await expect(client.emitWithAck('slots:subscribe', { date: DAY })).resolves.toEqual({ ok: true });
  });

  test('a missing payload is refused without taking the server down', async () => {
    const client = await signedIn();
    await expect(client.emitWithAck('slots:subscribe')).resolves.toEqual({ ok: false, code: 'VALIDATION_ERROR' });
    client.emit('slots:subscribe', { date: DAY }); // no acknowledgement callback
    await expect(client.emitWithAck('slots:unsubscribe', { date: DAY })).resolves.toEqual({ ok: true });
  });

  test('the sixth day is refused until another is released', async () => {
    const client = await signedIn();
    for (let day = 1; day <= 5; day += 1) {
      await expect(client.emitWithAck('slots:subscribe', { date: `2026-11-0${day}` })).resolves.toEqual({ ok: true });
    }

    await expect(client.emitWithAck('slots:subscribe', { date: '2026-11-06' }))
      .resolves.toEqual({ ok: false, code: 'TOO_MANY_SUBSCRIPTIONS' });
    await expect(client.emitWithAck('slots:subscribe', { date: '2026-11-05' })).resolves.toEqual({ ok: true });

    await client.emitWithAck('slots:unsubscribe', { date: '2026-11-01' });
    await expect(client.emitWithAck('slots:subscribe', { date: '2026-11-06' })).resolves.toEqual({ ok: true });
  });
});

describe('notifications', () => {
  const HOUR = 60 * 60 * 1000;
  const AT = new Date(Date.now() + 72 * HOUR);
  const DAY = toLocalDate(AT);
  const actor = { _id: new mongoose.Types.ObjectId(), email: 'sales@trustcar.vn' };

  let phone = 0;
  /** Connects a client that records everything it receives. */
  const watch = async (roleName, overrides = {}) => {
    const { id, token } = await tokenFor(roleName, overrides);
    const { client } = await connect({ token });
    const events = [];
    client.onAny((name, data) => events.push({ name, data }));
    return { id, client, events };
  };
  const watchCustomer = async () => {
    phone += 1;
    const number = `0902${String(phone).padStart(6, '0')}`;
    const customer = await h.createCustomer({ phone: number });
    return { customer, ...(await watch('CUSTOMER', { customer, phone: number })) };
  };
  /** A round trip: whatever the server sent before this has now arrived. */
  const settled = (...watchers) => Promise.all(watchers.map(({ client }) => client.emitWithAck('slots:unsubscribe', { date: '2000-01-01' })));
  const insert = (customer, overrides = {}) => h.insertAppointment({
    appointmentCode: `APT-${h.appointments.size + 1}`, customer, car: h.createCar(), assignedTo: staff.id, scheduledAt: AT, slotSeat: h.appointments.size + 1, ...overrides,
  });

  let staff;
  let admin;
  let owner;
  let other;
  let everyone;

  beforeEach(async () => {
    staff = await watch('SALES_STAFF');
    admin = await watch('ADMIN');
    owner = await watchCustomer();
    other = await watchCustomer();
    everyone = [staff, admin, owner, other];
    await other.client.emitWithAck('slots:subscribe', { date: DAY });
  });

  const expectNotified = async (id, status) => {
    await settled(...everyone);
    const change = { id, status };
    expect(staff.events).toEqual([{ name: 'appointment-changed', data: change }]);
    expect(admin.events).toEqual([{ name: 'appointment-changed', data: change }]);
    expect(owner.events).toEqual([{ name: 'my-appointment-changed', data: change }]);
    expect(other.events).toEqual([{ name: 'slots-changed', data: { date: DAY } }]);
  };

  test('confirming reaches staff, the owner and followers of that day, and nobody else', async () => {
    const id = insert(owner.customer);
    await staffService.confirm(id, actor);
    await expectNotified(id, 'CONFIRMED');
  });

  test('reassigning notifies', async () => {
    const id = insert(owner.customer);
    const free = await h.createUser({ roleName: 'SALES_STAFF' });
    await staffService.reassign(id, free.id, actor);
    await expectNotified(id, 'PENDING');
  });

  test('a staff cancellation notifies', async () => {
    const id = insert(owner.customer);
    await staffService.staffCancel(id, { reasonCode: 'OTHER', note: 'x' }, actor);
    await expectNotified(id, 'CANCELLED');
  });

  test('a customer cancellation notifies', async () => {
    const id = insert(owner.customer);
    await cancelMine({ _id: new mongoose.Types.ObjectId(owner.id), customer: owner.customer }, id);
    await expectNotified(id, 'CANCELLED');
  });

  test('the job cancelling for a sold car notifies', async () => {
    const id = insert(owner.customer, { car: h.createCar({ status: 'SOLD' }) });
    await cancelForUnavailableCars();
    await expectNotified(id, 'CANCELLED');
  });

  test.each([
    ['completing', 'complete', 'COMPLETED', (id) => [id, 'Khách hài lòng', actor]],
    ['no-show', 'markNoShow', 'NO_SHOW', (id) => [id, actor]],
  ])('%s notifies', async (_label, method, status, args) => {
    const id = insert(owner.customer, { status: 'CONFIRMED', scheduledAt: new Date(Date.now() - HOUR), slotSeat: 1 });
    const day = toLocalDate(new Date(Date.now() - HOUR));
    await other.client.emitWithAck('slots:subscribe', { date: day });

    await staffService[method](...args(id));

    await settled(...everyone);
    expect(staff.events).toEqual([{ name: 'appointment-changed', data: { id, status } }]);
    expect(owner.events).toEqual([{ name: 'my-appointment-changed', data: { id, status } }]);
    expect(other.events).toEqual([{ name: 'slots-changed', data: { date: day } }]);
  });

  test('correcting a no-show notifies', async () => {
    const id = insert(owner.customer, { status: 'NO_SHOW', slotSeat: undefined });
    await staffService.correctNoShow(id, 'Khách có đến', actor);
    await expectNotified(id, 'COMPLETED');
  });

  describe('booking', () => {
    const openSlot = () => {
      const settings = getDefaultBaseSettings();
      for (let i = 3; i < 14; i += 1) {
        const [slot] = generateSlots(toLocalDate(new Date(Date.now() + i * 24 * HOUR)), settings);
        if (slot) return slot;
      }
      throw new Error('No open slot found');
    };
    const asUser = ({ id, customer }) => ({ _id: new mongoose.Types.ObjectId(id), email: 'khach@trustcar.vn', customer });

    test('a booking notifies, within 2 seconds of returning', async () => {
      const slot = openSlot();
      const day = toLocalDate(slot.startAt);
      await other.client.emitWithAck('slots:subscribe', { date: day });
      const received = new Promise((resolve) => { other.client.once('slots-changed', resolve); });

      const booked = await bookOnline({ user: asUser(owner), carId: h.createCar(), scheduledAt: slot.startAt });
      const returnedAt = Date.now();

      await expect(received).resolves.toEqual({ date: day });
      expect(Date.now() - returnedAt).toBeLessThan(2000);
      await settled(...everyone);
      expect(staff.events).toEqual([{ name: 'appointment-changed', data: { id: booked.id, status: 'PENDING' } }]);
      expect(owner.events).toEqual([{ name: 'my-appointment-changed', data: { id: booked.id, status: 'PENDING' } }]);
    });

    test('a refused booking sends nothing', async () => {
      const slot = openSlot();
      const carId = h.createCar();
      await bookOnline({ user: asUser(owner), carId, scheduledAt: slot.startAt });
      await settled(...everyone);
      everyone.forEach(({ events }) => { events.length = 0; });

      await expect(bookOnline({ user: asUser(other), carId, scheduledAt: slot.startAt })).rejects.toMatchObject({ code: 'CAR_SLOT_TAKEN' });

      await settled(...everyone);
      everyone.forEach(({ events }) => expect(events).toEqual([]));
    });
  });

  test('a refused change sends nothing', async () => {
    const id = insert(owner.customer);
    await staffService.confirm(id, actor);
    await settled(...everyone);
    everyone.forEach(({ events }) => { events.length = 0; });

    await expect(staffService.confirm(id, actor)).rejects.toMatchObject({ statusCode: 409 });

    await settled(...everyone);
    everyone.forEach(({ events }) => expect(events).toEqual([]));
  });

  test('a change rolled back by a failure sends nothing', async () => {
    const id = insert(owner.customer);
    ActivityLog.create.mockRejectedValueOnce(new Error('audit write failed'));

    await expect(staffService.confirm(id, actor)).rejects.toThrow('audit write failed');

    await settled(...everyone);
    everyone.forEach(({ events }) => expect(events).toEqual([]));
    expect(h.appointment(id).status).toBe('PENDING');
  });

  test('a day nobody follows reaches no follower', async () => {
    await other.client.emitWithAck('slots:unsubscribe', { date: DAY });
    await staffService.confirm(insert(owner.customer), actor);
    await settled(...everyone);
    expect(other.events).toEqual([]);
  });

  test('a failure while notifying does not affect the change', async () => {
    const id = insert(owner.customer);
    const realtime = getRealtime();
    const originalTo = realtime.to;
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => {});
    realtime.to = () => { throw new Error('boom'); };
    await expect(staffService.confirm(id, actor)).resolves.toEqual({ id, status: 'CONFIRMED' });
    realtime.to = originalTo;
    expect(h.appointment(id).status).toBe('CONFIRMED');
    expect(logged.mock.calls.map(([line]) => line).join('\n')).toContain('Realtime notification failed');
    logged.mockRestore();
  });

  test('changes still work when realtime has not started', async () => {
    const id = insert(owner.customer);
    const warned = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    stopRealtime();
    await expect(staffService.confirm(id, actor)).resolves.toEqual({ id, status: 'CONFIRMED' });
    expect(warned.mock.calls.map(([line]) => line).join('\n')).toContain('Realtime is not running');
    warned.mockRestore();
  });
});

describe('stopping', () => {
  test('clients lose the transport, so they reconnect on their own, and the HTTP server can close', async () => {
    const { token } = await tokenFor('ADMIN');
    const { client } = await connect({ token });
    const reason = new Promise((resolve) => { client.once('disconnect', resolve); });

    stopRealtime();
    await new Promise((resolve) => { server.close(resolve); }); // never finishes if a connection stays open

    await expect(reason).resolves.toBe('transport close');
    expect(getRealtime()).toBeNull();
  });

  test('stopping twice is harmless', () => {
    stopRealtime();
    expect(() => stopRealtime()).not.toThrow();
  });
});
