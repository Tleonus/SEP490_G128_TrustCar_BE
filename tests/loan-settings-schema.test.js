/**
 * @file loan-settings-schema.test.js
 * @description Validation of PUT /api/v1/settings/loan with the bank list.
 * Uses the same Joi options as validateMiddleware.
 */

import { updateLoanSettingsSchema } from '../src/routes/loanSettingsSchemas.js';
import { getDefaultLoanSettings } from '../src/config/loanSettings.js';

const OPTIONS = { abortEarly: false, allowUnknown: false, stripUnknown: true, convert: true };
const check = (body) => updateLoanSettingsSchema.validate(body, OPTIONS);
const messages = (body) => (check(body).error?.details ?? []).map((detail) => detail.message);

const base = () => {
  const { minDownPaymentPct, minTermMonths, maxTermMonths, banks } = getDefaultLoanSettings();
  return { minDownPaymentPct, minTermMonths, maxTermMonths, banks };
};

describe('updateLoanSettingsSchema', () => {
  test('the default bank list is valid; scalar rates are optional when banks are sent', () => {
    expect(check(base()).error).toBeUndefined();
  });

  test('without banks the old 5-field body is still required', () => {
    const body = { minDownPaymentPct: 30, minTermMonths: 12, maxTermMonths: 84 };
    expect(messages(body)).toEqual(expect.arrayContaining(['preferredRateAnnual is required.', 'floatingRateAnnual is required.']));
    expect(check({ ...body, preferredRateAnnual: 8, floatingRateAnnual: 10 }).error).toBeUndefined();
  });

  test('exactly one partner bank, and it must be shown', () => {
    const none = base();
    none.banks[0].isPartner = false;
    expect(messages(none)).toContain('Phải chọn đúng 1 ngân hàng liên kết.');

    const two = base();
    two.banks[1].isPartner = true;
    expect(messages(two)).toContain('Phải chọn đúng 1 ngân hàng liên kết.');

    const hidden = base();
    hidden.banks[0].active = false;
    expect(messages(hidden)).toContain('Ngân hàng liên kết phải đang hiện trên trang tính.');
  });

  test('old promo-period and post-promotion fields are stripped', () => {
    const body = base();
    Object.assign(body.banks[1], { promoMonths: 12, floatingRate: 11, baseRate: 10.9, margin: 0.99 });
    const { error, value } = check(body);
    expect(error).toBeUndefined();
    ['promoMonths', 'floatingRate', 'baseRate', 'margin'].forEach((field) => expect(value.banks[1]).not.toHaveProperty(field));
  });

  test('term min ≤ max; conditions in range', () => {
    const terms = base();
    terms.banks[1].minTermMonths = 60;
    terms.banks[1].maxTermMonths = 48;
    expect(messages(terms).join(' ')).toMatch(/tối thiểu không được lớn hơn/);

    const pct = base();
    pct.banks[1].maxLoanPct = 120;
    expect(messages(pct)).toContain('Tỷ lệ cho vay tối đa phải từ 1 đến 100% giá xe.');
  });

  test('duplicate ids, bad rates and bad URLs are rejected', () => {
    const dup = base();
    dup.banks[1].id = 'TPBANK';
    expect(messages(dup)).toContain('Mã ngân hàng bị trùng.');

    const rate = base();
    rate.banks[1].promoRate = 41;
    expect(messages(rate)).toContain('Lãi suất phải từ 0 đến 40 %/năm.');

    const url = base();
    url.banks[1].sourceUrl = 'javascript:alert(1)';
    expect(messages(url)).toContain('Link nguồn phải là địa chỉ web (http/https).');
  });

  test('min down payment at most 90 %, term max > term min, bank count 1–10', () => {
    expect(messages({ ...base(), minDownPaymentPct: 95 })).toContain('Trả trước tối thiểu phải từ 0 đến 90%.');
    expect(messages({ ...base(), minTermMonths: 84, maxTermMonths: 84 })).toContain('Thời hạn tối đa phải lớn hơn thời hạn tối thiểu.');
    expect(messages({ ...base(), banks: [] })).toContain('Cần ít nhất 1 ngân hàng.');
  });

  test('term options replace min/max term; duplicates, out-of-range and low down-payment options are rejected', () => {
    const { minDownPaymentPct, banks } = base();
    const body = { minDownPaymentPct, banks, termOptions: [12, 18, 24], downPaymentOptions: [30, 45] };
    expect(check(body).error).toBeUndefined();
    expect(messages({ ...body, termOptions: [12, 12] })).toContain('Thời hạn vay bị trùng.');
    expect(messages({ ...body, termOptions: [121] })).toContain('Thời hạn vay phải từ 1 đến 120 tháng.');
    expect(messages({ ...body, termOptions: [] })).toContain('Cần ít nhất 1 thời hạn vay.');
    expect(messages({ ...body, downPaymentOptions: [20, 40] })).toContain('Mức trả trước 20% thấp hơn trả trước tối thiểu 30%.');
  });

  test('ids are upper-cased and unknown bank fields stripped', () => {
    const body = base();
    body.banks[1].id = 'msb';
    body.banks[1].hack = 'x';
    const { value, error } = check(body);
    expect(error).toBeUndefined();
    expect(value.banks[1].id).toBe('MSB');
    expect(value.banks[1].hack).toBeUndefined();
  });
});
