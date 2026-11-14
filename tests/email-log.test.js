/**
 * @file email-log.test.js
 * @description KAN-39: every send attempt is recorded with a masked address,
 * and only an admin can read the log.
 */

import { jest } from '@jest/globals';

const create = jest.fn();
const find = jest.fn();
const countDocuments = jest.fn();

jest.unstable_mockModule('../src/models/EmailLog.js', () => ({
  default: { create: (...args) => create(...args), find: (...args) => find(...args), countDocuments: (...args) => countDocuments(...args) },
  EmailStatus: { SENT: 'SENT', FAILED: 'FAILED', SKIPPED: 'SKIPPED' },
}));

const { recordEmailAttempt, listEmailLogs, maskEmail } = await import('../src/services/emailLogService.js');

const chain = (rows) => ({ sort: () => chain(rows), skip: () => chain(rows), limit: () => chain(rows), lean: async () => rows });

beforeEach(() => {
  create.mockReset().mockResolvedValue({});
  find.mockReset();
  countDocuments.mockReset().mockResolvedValue(0);
});

test('masks the local part and keeps the domain', () => {
  expect(maskEmail('khach@gmail.com')).toBe('k***@gmail.com');
  expect(maskEmail('not-an-email')).toBe('not-an-email');
});

test('records a sent attempt without the full address', async () => {
  await recordEmailAttempt({ to: 'khach@gmail.com', subject: 'Xác nhận', transport: 'mailersend', status: 'SENT' });

  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    toMasked: 'k***@gmail.com', subject: 'Xác nhận', transport: 'mailersend', status: 'SENT', error: null,
  }));
});

test('scrubs any address echoed in a failure message', async () => {
  await recordEmailAttempt({
    to: 'khach@gmail.com', subject: 'Xác nhận', transport: 'smtp', status: 'FAILED',
    error: '550 relay denied for khach@gmail.com',
  });

  const saved = create.mock.calls[0][0];
  expect(saved.status).toBe('FAILED');
  expect(saved.error).toBe('550 relay denied for [redacted]');
  expect(saved.error).not.toContain('khach@gmail.com');
});

test('a logging failure does not propagate', async () => {
  create.mockRejectedValue(new Error('db down'));

  await expect(recordEmailAttempt({ to: 'a@b.c', subject: '', transport: 'none', status: 'SKIPPED' })).resolves.toBeUndefined();
});

test('lists newest first and rejects an unknown status', async () => {
  find.mockReturnValue(chain([{ status: 'SENT' }]));
  countDocuments.mockResolvedValue(1);

  const { items, pagination } = await listEmailLogs({ status: 'sent', page: '1', limit: '10' });

  expect(find.mock.calls[0][0]).toEqual({ status: 'SENT' });
  expect(items).toHaveLength(1);
  expect(pagination.totalPages).toBe(1);

  await expect(listEmailLogs({ status: 'MAYBE' })).rejects.toMatchObject({ statusCode: 422 });
});
