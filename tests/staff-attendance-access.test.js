/**
 * @file staff-attendance-access.test.js
 * @description HTTP layer of staff attendance and visit reassignment on the real Express app
 * (in-memory models): who may read / mark attendance, who may grant that permission, input
 * validation.
 */

import mongoose from 'mongoose';
import { default as request } from 'supertest';
import { setupAuthHarness } from './helpers/fakeAuthModels.js';

const h = await setupAuthHarness();
const { setupAppointmentFakes } = await import('./helpers/fakeAppointmentModels.js');
const { signAccessToken } = await import('../src/utils/authTokens.js');
const { vnDateKey } = await import('../src/services/appointmentSlotRules.js');
const fakes = await setupAppointmentFakes();

const API = '/api/v1';
const oid = () => String(new mongoose.Types.ObjectId());
const today = () => vnDateKey(new Date());

let phone = 0;
const tokenFor = async (overrides) => {
  phone += 1;
  const { id } = await h.createUser({ phone: `09022345${String(phone).padStart(2, '0')}`, ...overrides });
  return signAccessToken(await h.User.findById(id).select('+tokenVersion'));
};
const send = (method, url, token, body) => {
  const req = request(h.app)[method](`${API}${url}`).set('X-Forwarded-For', h.nextIp());
  if (token) req.set('Authorization', `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};

beforeEach(() => { h.reset(); fakes.reset(); fakes.enableStaffing(); });

describe('staff attendance access', () => {
  it('no token → 401; a salesperson without the permission → 403; with it → 200; ADMIN → 200', async () => {
    expect((await send('get', `/staff-attendance?date=${today()}`)).status).toBe(401);
    const plain = await tokenFor({ roleName: 'SALES_STAFF' });
    const denied = await send('get', `/staff-attendance?date=${today()}`, plain);
    expect(denied.status).toBe(403);
    expect(denied.body.code ?? denied.body.error?.code).toBe('ATTENDANCE_FORBIDDEN');

    const keeper = await tokenFor({ roleName: 'SALES_STAFF', canTakeAttendance: true });
    const allowed = await send('get', `/staff-attendance?date=${today()}`, keeper);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data).toMatchObject({ date: today(), editable: true, canManageKeepers: false });

    const admin = await tokenFor({ roleName: 'ADMIN' });
    const asAdmin = await send('get', `/staff-attendance?date=${today()}`, admin);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.data.canManageKeepers).toBe(true);
  });

  it('only an ADMIN grants the permission', async () => {
    const keeper = await tokenFor({ roleName: 'SALES_STAFF', canTakeAttendance: true });
    expect((await send('patch', `/staff-attendance/keepers/${oid()}`, keeper, { enabled: true })).status).toBe(403);
    const admin = await tokenFor({ roleName: 'ADMIN' });
    const target = fakes.addStaff();
    const res = await send('patch', `/staff-attendance/keepers/${target._id}`, admin, { enabled: true });
    expect(res.status).toBe(200);
    expect(target.canTakeAttendance).toBe(true);
  });

  it('marks a salesperson off and validates the input', async () => {
    const admin = await tokenFor({ roleName: 'ADMIN' });
    const target = fakes.addStaff();
    const ok = await send('put', `/staff-attendance/${today()}/${target._id}`, admin, { present: false });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ present: false, reassigned: [], unassigned: [] });
    expect(fakes.attendance).toEqual([expect.objectContaining({ date: today(), present: false })]);

    expect((await send('put', `/staff-attendance/${today()}/${target._id}`, admin, { present: 'no' })).status).toBe(422);
    expect((await send('put', `/staff-attendance/${today()}/${target._id}`, admin, { present: false, x: 1 })).status).toBe(422);
    expect((await send('put', `/staff-attendance/2026-1-1/${target._id}`, admin, { present: false })).status).not.toBe(200);
    expect((await send('get', '/staff-attendance', admin)).status).toBe(422);
  });

  it('reassignment needs appointment:update and a staffId', async () => {
    expect((await send('patch', `/appointments/${oid()}/assignee`, null, { staffId: oid() })).status).toBe(401);
    const customer = await tokenFor({ roleName: 'CUSTOMER', customer: fakes.addCustomer()._id });
    expect((await send('patch', `/appointments/${oid()}/assignee`, customer, { staffId: oid() })).status).toBe(403);
    const sales = await tokenFor({ roleName: 'SALES_STAFF' });
    expect((await send('patch', `/appointments/${oid()}/assignee`, sales, {})).status).toBe(422);
    expect((await send('get', `/appointments/${oid()}/assignees`, sales)).status).toBe(404);
  });
});
