/**
 * @file profile-phone.test.js
 * @description Changing the phone: normalised and stored in both records; a phone that belongs to
 * another customer is refused (409) without changing anything; your own phone is not a clash;
 * and two customers racing for the same new phone end with exactly one winner.
 *
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-007
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-008
 * @ears .sdd/features/user-profile-settings/SPEC.md#REQ-010
 */

import { setupAuthHarness } from './helpers/fakeAuthModels.js';
import { makeCaller, makeCustomer } from './helpers/profileFixtures.js';

const h = await setupAuthHarness();
const call = makeCaller(h);
beforeEach(() => h.reset());

const patch = (token, body) => call('patch', '/api/v1/profile', token).send(body);
const snapshot = () => JSON.stringify({ users: [...h.users.values()], customers: [...h.customers.values()] });

describe('a new phone (AC-06)', () => {
  test('+84… is normalised to 0… and stored in both User and Customer', async () => {
    const { token, id, customerId } = await makeCustomer(h, { phone: '0901111111' });
    const res = await patch(token, { phone: '+84901234567' });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('0901234567');
    expect(h.stored(id).phone).toBe('0901234567');
    expect(h.customers.get(customerId).phone).toBe('0901234567');
  });

  test('a free phone of the same format is saved as typed', async () => {
    const { token, id } = await makeCustomer(h, { phone: '0901111111' });
    await patch(token, { phone: '0987654321' });
    expect(h.stored(id).phone).toBe('0987654321');
  });

  test('name and phone together keep User and Customer equal (REQ-008)', async () => {
    const { token, id, customerId } = await makeCustomer(h, { phone: '0901111111', fullName: 'Cũ' });
    await patch(token, { fullName: 'Mới', phone: '0907777777' });
    expect([h.stored(id).fullName, h.stored(id).phone]).toEqual([h.customers.get(customerId).fullName, h.customers.get(customerId).phone]);
    expect(h.stored(id).phone).toBe('0907777777');
  });
});

describe('a phone that belongs to another customer (AC-07)', () => {
  test('409 PHONE_ALREADY_EXISTS and neither record changes', async () => {
    await makeCustomer(h, { phone: '0902222222', fullName: 'Người Khác' });
    const { token } = await makeCustomer(h, { phone: '0901111111' });
    const before = snapshot();
    const res = await patch(token, { phone: '0902222222', fullName: 'Tên Không Được Đổi' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHONE_ALREADY_EXISTS');
    expect(snapshot()).toBe(before); // not even the name that came with it
    expect(h.logs).toHaveLength(0);
  });

  test('the same phone typed as +84 is recognised as the same number', async () => {
    await makeCustomer(h, { phone: '0902222222' });
    const { token } = await makeCustomer(h, { phone: '0901111111' });
    expect((await patch(token, { phone: '+84902222222' })).status).toBe(409);
  });

  test('the other customer is not affected', async () => {
    const other = await makeCustomer(h, { phone: '0902222222', fullName: 'Người Khác' });
    const { token } = await makeCustomer(h, { phone: '0901111111' });
    await patch(token, { phone: '0902222222' });
    expect(h.stored(other.id).phone).toBe('0902222222');
    expect(h.stored(other.id).fullName).toBe('Người Khác');
  });
});

describe('your own phone (AC-08)', () => {
  test('sending the phone you already have is fine, and changes nothing', async () => {
    const { token } = await makeCustomer(h, { phone: '0901111111' });
    const before = snapshot();
    const res = await patch(token, { phone: '0901111111' });
    expect(res.status).toBe(200);
    expect(snapshot()).toBe(before);
    expect(h.logs).toHaveLength(0);
  });

  test('a staff account using the same phone as a customer is not a clash', async () => {
    const { token } = await makeCustomer(h, { phone: '0901111111' });
    await h.createUser({ roleName: 'ADMIN', phone: '0907777777' });
    expect((await patch(token, { phone: '0907777777' })).status).toBe(200);
  });
});

describe('a race for the same new phone (AC-09, REQ-010)', () => {
  test('two customers PATCH the same phone at once: exactly one 200 and one 409', async () => {
    const a = await makeCustomer(h, { phone: '0901000001' });
    const b = await makeCustomer(h, { phone: '0901000002' });
    const [ra, rb] = await Promise.all([patch(a.token, { phone: '0909999999' }), patch(b.token, { phone: '0909999999' })]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const winners = [a, b].filter((c) => h.stored(c.id).phone === '0909999999');
    expect(winners).toHaveLength(1);
    expect(h.customers.get(winners[0].customerId).phone).toBe('0909999999');
    const loser = [a, b].find((c) => c !== winners[0]);
    expect(h.stored(loser.id).phone).toBe(loser.phone); // the loser kept their old phone, in both records
    expect(h.customers.get(loser.customerId).phone).toBe(loser.phone);
  });

  test('when the early check is skipped, the unique index still decides (11000 is mapped to 409)', async () => {
    const { jest } = await import('@jest/globals');
    const a = await makeCustomer(h, { phone: '0901000001' });
    await makeCustomer(h, { phone: '0901000002' });
    jest.spyOn(h.User, 'exists').mockResolvedValueOnce(null); // as if both requests passed the early check
    const res = await patch(a.token, { phone: '0901000002' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHONE_ALREADY_EXISTS');
    expect(h.stored(a.id).phone).toBe('0901000001');
  });
});

describe('invalid phones are refused before anything happens', () => {
  test.each([[''], ['123'], ['abc'], [null]])('%j → 422', async (phone) => {
    const { token } = await makeCustomer(h, { phone: '0901111111' });
    const before = snapshot();
    const res = await patch(token, { phone });
    expect(res.status).toBe(422);
    expect(snapshot()).toBe(before);
  });
});
