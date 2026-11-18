/**
 * @file profileFixtures.js
 * @description Accounts and requests for the profile tests, on top of the in-memory auth harness
 * (`setupAuthHarness`). A complete customer is a `User` linked to a `Customer`; staff have no Customer.
 */

import { default as request } from 'supertest';

let counter = 0;

/** `call(method, url, token)`: a supertest request with its own client IP (no rate-limit noise). */
export const makeCaller = (h) => (method, url, token) => {
  const req = request(h.app)[method](url).set('X-Forwarded-For', h.nextIp());
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

const tokenOf = async (h, id) => {
  const { signAccessToken } = await import('../../src/utils/authTokens.js');
  return signAccessToken(await h.User.findById(id).select('+tokenVersion'));
};

/**
 * A complete customer: User (name, phone, password) linked to a Customer with the extended fields.
 * @returns {{ id: string, customerId: string, token: string, email: string }}
 */
export const makeCustomer = async (h, { phone, fullName = 'Nguyễn An', customer = {}, user = {} } = {}) => {
  counter += 1;
  const number = phone ?? `09012345${String(counter % 100).padStart(2, '0')}`;
  const customerId = await h.createCustomer({ fullName, phone: number, ...customer });
  const created = await h.createUser({ roleName: 'CUSTOMER', fullName, phone: number, customer: customerId, ...user });
  return { id: created.id, customerId, email: created.email, token: await tokenOf(h, created.id), phone: number };
};

/** A staff account (no Customer). */
export const makeStaff = async (h, roleName = 'SALES_STAFF', overrides = {}) => {
  const created = await h.createUser({ roleName, fullName: 'Lan Sales', phone: '0911000111', ...overrides });
  return { id: created.id, email: created.email, token: await tokenOf(h, created.id) };
};

/** A Google-created customer whose profile is not complete (no phone, no password). */
export const makeIncompleteCustomer = async (h) => {
  const created = await h.createUser({
    roleName: 'CUSTOMER', firebaseUid: `g-${Date.now()}-${Math.random()}`, password: null, fullName: undefined,
  });
  return { id: created.id, token: await tokenOf(h, created.id) };
};

export const tokenFor = tokenOf;
