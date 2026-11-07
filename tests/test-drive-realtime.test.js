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
const { signAccessToken, signRefreshToken } = await import('../src/utils/authTokens.js');
const { getRealtime, startRealtime, stopRealtime } = await import('../src/config/realtime.js');

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

  test('other roles join no group', async () => {
    const { token } = await tokenFor('INSPECTOR');
    await connect({ token });
    expect(await roomSize('staff')).toBe(0);
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
