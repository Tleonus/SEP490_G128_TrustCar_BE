/**
 * @file vnpay-ipn.test.js
 * @description KAN-99 — integration test of handleVnpayIpn covering the full
 * outcome matrix (APPLIED / DUPLICATE / INVALID_SIGNATURE / DEPOSIT_NOT_FOUND
 * / DEPOSIT_INVALID_STATE / AMOUNT_MISMATCH / PROVIDER_FAILURE).
 *
 * Deposit, VnpayIpnLog and ActivityLog methods are replaced in place by the
 * fakes in `tests/helpers/fakeVnpayIpnModels.js` — see the harness docstring
 * for why that helper is required to live under `tests/helpers/`.
 */

import { jest } from '@jest/globals';
import { setupVnpayFakes } from './helpers/fakeVnpayIpnModels.js';
import { handleVnpayIpn } from '../src/services/vnpayIpnService.js';
import { signParams } from '../src/services/vnpayService.js';
import {
  DepositStatus,
  DepositPaymentStatus,
  IpnOutcome,
  PaymentProvider,
} from '../src/constants/depositConstants.js';

const SECRET = 'TESTSECRET_4A6D5F8C2B9E1A7D';

const ENV = {
  VNPAY_TMN_CODE: 'TMNTEST',
  VNPAY_HASH_SECRET: SECRET,
  VNPAY_RETURN_URL: 'https://staging.trustcar.vn/dat-coc/vnpay-return',
  VNPAY_PAYMENT_URL: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  VNPAY_TIMEOUT_MINUTES: '15',
};

const makeDeposit = (overrides = {}) => ({
  _id: 'dep-1',
  depositCode: 'DC-261120-ABC123',
  carId: 'car-1',
  carVehicleCode: 'TC-2026-0001',
  userId: 'user-1',
  customerId: 'cust-1',
  depositAmount: 10_000_000,
  currency: 'VND',
  status: DepositStatus.PENDING_PAYMENT,
  paymentStatus: DepositPaymentStatus.UNPAID,
  paymentProvider: PaymentProvider.VNPAY,
  vnpayTxnRef: 'DEP-DC-261120-ABC123-1700000000',
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  reservedAt: new Date(),
  holdActive: true,
  history: [],
  ...overrides,
});

const makeIpn = (txnRef, amountVnd, overrides = {}) => {
  const payload = {
    vnp_Version:          '2.1.0',
    vnp_Command:          'pay',
    vnp_TmnCode:          'TMNTEST',
    vnp_Amount:           String(Math.round(amountVnd * 100)),
    vnp_CurrCode:         'VND',
    vnp_TxnRef:           txnRef,
    vnp_TransactionNo:    '14600314',
    vnp_ResponseCode:     '00',
    vnp_TransactionStatus:'00',
    vnp_BankCode:         'NCB',
    vnp_BankTranNo:       'VNP14600314',
    vnp_CardType:         'ATM',
    vnp_PayDate:          '20261120103045',
    vnp_OrderInfo:        'Dat coc xe TC-2026-0001',
    ...overrides,
  };
  payload.vnp_SecureHash = signParams(payload, SECRET);
  return payload;
};

const applyEnv = () => {
  Object.entries(ENV).forEach(([k, v]) => { process.env[k] = v; });
};
const clearEnv = () => {
  Object.keys(ENV).forEach((k) => { delete process.env[k]; });
};

describe('handleVnpayIpn: full outcome matrix', () => {
  let fakes;

  beforeEach(() => {
    applyEnv();
    fakes = setupVnpayFakes();
  });
  afterEach(() => {
    fakes.reset();
    clearEnv();
    jest.restoreAllMocks();
  });

  test('APPLIED: promotes PENDING → DEPOSIT_PAID, logs APPLIED, replies 00', async () => {
    fakes.addDeposit(makeDeposit());
    const query = makeIpn('DEP-DC-261120-ABC123-1700000000', 10_000_000);

    const result = await handleVnpayIpn({ query, ipAddress: '118.69.126.44' });

    expect(result.outcome).toBe(IpnOutcome.APPLIED);
    expect(result.RspCode).toBe('00');
    expect(result.Message).toBe('Confirm Success');
    expect(fakes.deposits[0].status).toBe(DepositStatus.DEPOSIT_PAID);
    expect(fakes.deposits[0].paymentStatus).toBe(DepositPaymentStatus.DEPOSIT_PAID);
    expect(fakes.deposits[0].vnpayTransactionNo).toBe('14600314');
    expect(fakes.deposits[0].vnpayBankCode).toBe('NCB');
    expect(fakes.deposits[0].paidAt).toBeInstanceOf(Date);
    expect(fakes.deposits[0].history.at(-1).action).toBe('DEPOSIT_VNPAY_IPN_APPLIED');
    expect(fakes.ipnLogs.at(-1).outcome).toBe(IpnOutcome.APPLIED);
    expect(fakes.activityLogs.at(-1).metadata.source).toBe('VNPAY');
  });

  test('INVALID_SIGNATURE: never touches the deposit, replies 97', async () => {
    fakes.addDeposit(makeDeposit());
    const query = makeIpn('DEP-DC-261120-ABC123-1700000000', 10_000_000);
    query.vnp_SecureHash = '0'.repeat(128); // obviously forged

    const result = await handleVnpayIpn({ query, ipAddress: '1.1.1.1' });

    expect(result.outcome).toBe(IpnOutcome.INVALID_SIGNATURE);
    expect(result.RspCode).toBe('97');
    expect(fakes.deposits[0].status).toBe(DepositStatus.PENDING_PAYMENT);
    expect(fakes.deposits[0].paymentStatus).toBe(DepositPaymentStatus.UNPAID);
    expect(fakes.ipnLogs.at(-1).outcome).toBe(IpnOutcome.INVALID_SIGNATURE);
  });

  test('DEPOSIT_NOT_FOUND: vnp_TxnRef is unknown → RspCode 01', async () => {
    const query = makeIpn('DEP-DC-UNKNOWN-1', 10_000_000);

    const result = await handleVnpayIpn({ query, ipAddress: '1.1.1.1' });

    expect(result.outcome).toBe(IpnOutcome.DEPOSIT_NOT_FOUND);
    expect(result.RspCode).toBe('01');
  });

  test('AMOUNT_MISMATCH: reported amount ≠ deposit × 100 → RspCode 04 + reviewRequired', async () => {
    fakes.addDeposit(makeDeposit());
    const tampered = makeIpn('DEP-DC-261120-ABC123-1700000000', 5_000_000); // half

    const result = await handleVnpayIpn({ query: tampered, ipAddress: '1.1.1.1' });

    expect(result.outcome).toBe(IpnOutcome.AMOUNT_MISMATCH);
    expect(result.RspCode).toBe('04');
    expect(fakes.deposits[0].status).toBe(DepositStatus.PENDING_PAYMENT);
    expect(fakes.deposits[0].reviewRequired).toBe(true);
  });

  test('DUPLICATE: second IPN with same txnRef+transactionNo replays the cached response', async () => {
    fakes.addDeposit(makeDeposit());
    const query = makeIpn('DEP-DC-261120-ABC123-1700000000', 10_000_000);

    const first = await handleVnpayIpn({ query, ipAddress: '1.1.1.1' });
    expect(first.outcome).toBe(IpnOutcome.APPLIED);

    // VNPay retries the same payload — must not double-apply.
    const second = await handleVnpayIpn({ query, ipAddress: '1.1.1.1' });

    expect(second.outcome).toBe(IpnOutcome.DUPLICATE);
    expect(second.RspCode).toBe('00');
    // Only one APPLIED log row exists.
    expect(fakes.ipnLogs.filter((l) => l.outcome === IpnOutcome.APPLIED)).toHaveLength(1);
    // The DUPLICATE row is on top of the APPLIED row.
    expect(fakes.ipnLogs.at(-1).outcome).toBe(IpnOutcome.DUPLICATE);
  });

  test('DEPOSIT_INVALID_STATE: deposit already in DEPOSIT_PAID → RspCode 02', async () => {
    fakes.addDeposit(makeDeposit({
      status: DepositStatus.DEPOSIT_PAID,
      paymentStatus: DepositPaymentStatus.DEPOSIT_PAID,
    }));
    // Different vnpTransactionNo so idempotency doesn't short-circuit.
    const query = makeIpn('DEP-DC-261120-ABC123-1700000000', 10_000_000, { vnp_TransactionNo: '99999999' });

    const result = await handleVnpayIpn({ query, ipAddress: '1.1.1.1' });

    expect(result.outcome).toBe(IpnOutcome.DEPOSIT_INVALID_STATE);
    expect(result.RspCode).toBe('02');
    expect(fakes.deposits[0].reviewRequired).toBe(true);
  });

  test('PROVIDER_FAILURE: customer cancelled (vnp_ResponseCode 24) → ack but no promotion', async () => {
    fakes.addDeposit(makeDeposit());
    const query = makeIpn('DEP-DC-261120-ABC123-1700000000', 10_000_000, {
      vnp_ResponseCode: '24',
      vnp_TransactionStatus: '24',
    });

    const result = await handleVnpayIpn({ query, ipAddress: '1.1.1.1' });

    expect(result.outcome).toBe(IpnOutcome.PROVIDER_FAILURE);
    expect(result.RspCode).toBe('00'); // ack to VNPay so it stops retrying
    expect(fakes.deposits[0].status).toBe(DepositStatus.PENDING_PAYMENT);
    expect(fakes.deposits[0].paymentStatus).toBe(DepositPaymentStatus.UNPAID);
  });

  test('vnp_Amount parse failure (missing): treated as AMOUNT_MISMATCH', async () => {
    fakes.addDeposit(makeDeposit());
    const query = makeIpn('DEP-DC-261120-ABC123-1700000000', 10_000_000);
    delete query.vnp_Amount;
    // Re-sign without the amount so the signature still verifies.
    delete query.vnp_SecureHash;
    query.vnp_SecureHash = signParams(query, SECRET);

    const result = await handleVnpayIpn({ query, ipAddress: '1.1.1.1' });

    expect(result.outcome).toBe(IpnOutcome.AMOUNT_MISMATCH);
    expect(result.RspCode).toBe('04');
  });
});
