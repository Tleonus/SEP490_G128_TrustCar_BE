/**
 * @file public-car-list.test.js
 * @description The public catalog exposes the CPO certificate code so the FE can show the badge.
 */

import { jest } from '@jest/globals';
import Car from '../src/models/Car.js';
import { getAvailableCars } from '../src/services/publicCarService.js';

test('public car list projection includes cpoCertificateId', async () => {
  const chain = { sort: () => chain, skip: () => chain, limit: () => chain, lean: async () => [] };
  const find = jest.spyOn(Car, 'find').mockReturnValue(chain);
  jest.spyOn(Car, 'countDocuments').mockResolvedValue(0);

  await getAvailableCars({});

  expect(find.mock.calls[0][1]).toMatchObject({ cpoCertificateId: 1 });
  expect(find.mock.calls[0][1]).not.toHaveProperty('internalNotes');
});
