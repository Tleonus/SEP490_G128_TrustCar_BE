/**
 * @file mailer.test.js
 * @description src/config/mailer.js – MailerSend API failures surface as
 * readable Errors (status + MailerSend message) instead of a plain object
 * whose `message` is undefined. The mailersend SDK is mocked: no network.
 */

import { jest } from '@jest/globals';

const send = jest.fn();

jest.unstable_mockModule('mailersend', () => ({
  MailerSend: jest.fn(() => ({ email: { send } })),
  EmailParams: jest.fn(function EmailParams() {
    const self = this;
    ['setFrom', 'setTo', 'setSubject', 'setHtml', 'setText'].forEach((m) => { self[m] = () => self; });
  }),
  Sender: jest.fn(),
  Recipient: jest.fn(),
}));

process.env.MAILERSEND_API_KEY = 'mlsn.test-secret-key';
const { sendMail } = await import('../src/config/mailer.js');

const mail = { to: 'khach@gmail.com', subject: 'TrustCar – Password Reset Request', html: '<p>link-secret</p>' };

beforeEach(() => send.mockReset());

describe('sendMail via MailerSend', () => {
  test('resolves when MailerSend accepts the email', async () => {
    send.mockResolvedValue({ statusCode: 202 });
    await expect(sendMail(mail)).resolves.toBeUndefined();
  });

  test('an API rejection becomes an Error with status and MailerSend message', async () => {
    send.mockRejectedValue({
      statusCode: 422,
      body: { message: 'The from.email domain must be verified in your account to send emails. #MS42207' },
      headers: {},
    });

    const error = await sendMail(mail).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('MailerSend 422: The from.email domain must be verified in your account to send emails. #MS42207');
    expect(error.statusCode).toBe(422);
  });

  test('a rejection without body still gives a readable message', async () => {
    send.mockRejectedValue({ statusCode: 401 });
    await expect(sendMail(mail)).rejects.toThrow('MailerSend 401: no error message returned');
  });

  test('network errors (already Error instances) are passed through unchanged', async () => {
    const network = new Error('getaddrinfo ENOTFOUND api.mailersend.com');
    send.mockRejectedValue(network);
    await expect(sendMail(mail)).rejects.toBe(network);
  });

  test('the error never contains the API key or the email content', async () => {
    send.mockRejectedValue({ statusCode: 401, body: { message: 'Unauthenticated.' } });
    const error = await sendMail(mail).catch((e) => e);
    expect(error.message).not.toContain('mlsn.test-secret-key');
    expect(error.message).not.toContain('link-secret');
  });
});
