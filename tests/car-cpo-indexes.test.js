import { expect, test } from '@jest/globals';
import Car from '../src/models/Car.js';

test.each([
  ['cpoCertificateId', 'uniq_car_cpo_certificate_string'],
  ['historyVerifyHash', 'uniq_car_history_verify_hash_string'],
])('keeps %s nullable and enforces uniqueness for assigned strings', (field, name) => {
  const indexes = Car.schema.indexes().filter(([keys]) => Object.hasOwn(keys, field));
  expect(indexes).toHaveLength(1);

  const [[keys, options]] = indexes;
  expect(keys).toEqual({ [field]: 1 });
  expect(options).toMatchObject({ unique: true, name });
  expect(options.partialFilterExpression).toEqual({ [field]: { $type: 'string' } });
  expect(options).not.toHaveProperty('sparse');

  expect(new Car()[field]).toBeNull();
  expect(new Car({ [field]: '  fixture-value  ' })[field]).toBe('fixture-value');
});
