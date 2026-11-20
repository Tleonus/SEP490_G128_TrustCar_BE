# KAN-99 — VNPay Sandbox Integration cho Tiền Cọc Giữ Xe

**Owner:** Nguyễn Hữu Tú (fullstack)
**Depends on:** KAN-22 (Deposit module, đã có sẵn)
**Target:** Staging + Production (chạy sandbox, không bật live key cho đồ án)
**Due:** 08/12/2026

---

## 0. Scope đã chốt (20/11/2026)

| Câu hỏi | Chốt |
|---|---|
| Cổng thanh toán | **Chỉ VNPay sandbox** (không thêm Momo/ZaloPay trong sprint này) |
| Số tiền cọc | **% giá xe theo config global** — tái sử dụng `DEPOSIT_SUGGESTED_PERCENT` env đã có (mặc định 5%) + bounds `minPercent=1`, `maxPercent=30` |
| Refund | **Record thủ công như hiện tại** — không gọi VNPay Refund API; chỉ reset `paymentStatus = REFUNDED` và ghi note |

Những cái KHÔNG làm trong KAN-99 (để tránh scope creep):
- Không thanh toán toàn bộ giá trị xe qua VNPay (vì xe cũ 500tr–1 tỷ vượt limit VNPay thường + nghiệp vụ Việt Nam không ai thanh toán cả xe online).
- Không ký hợp đồng Merchant thật — chỉ dùng sandbox `sandbox.vnpayment.vn`.
- Không tự host webhook public từ máy dev — đợi KAN-49 staging đã live.
- Không thêm mã QR thanh toán VNPay QR Code (nếu thừa thời gian sprint sau).

---

## 1. Bối cảnh & Vấn đề hiện tại

**Hiện trạng** (ngày 20/11, sau khi KAN-22 Đang đã merge):
- Deposit model đã có đầy đủ 2 state machine (`status` và `paymentStatus`), transition đã lock bằng conditional update + unique partial index `uniq_active_hold_per_car`.
- Endpoint `PATCH /deposits/:id/confirm-payment` **yêu cầu role `ADMIN` hoặc `SALES_STAFF`** — tức là tiền cọc đến đâu phải sale mở sao kê ngân hàng ra kiểm, bấm xác nhận bằng tay. Mã giao dịch nhập chay vào field `paymentReference`.
- Khách không thấy được trạng thái realtime, chỉ biết "đã chuyển khoản, chờ showroom xác nhận".

**Vấn đề:**
- Chậm (vào cuối tuần sale không online → cọc có thể EXPIRE do không ai confirm kịp).
- Không scale (demo hội đồng không thể gọi điện cho sale).
- Có thể bị gian lận (sale confirm nhầm giao dịch của khách khác trùng số tiền).

**Giá trị cho đồ án:**
- Tích hợp cổng thanh toán thật là một trong các "wow factor" cho hội đồng phản biện SEP490.
- VNPay có doc tiếng Việt, cộng đồng support, sandbox free, không cần giấy phép doanh nghiệp.
- Chứng minh được: HMAC-SHA512 signature verify, webhook idempotency, state-machine integration với module khác.

---

## 2. Database

**Không tạo collection mới.** Mở rộng bảng `deposits` hiện có + thêm 1 collection nhỏ cho idempotency log.

### 2.1. Mở rộng `deposits` (6 field mới, tất cả nullable)

| Trường | Kiểu | Giải thích |
|---|---|---|
| `paymentProvider` | `String` enum `['MANUAL', 'VNPAY']`, default `'MANUAL'` | Cọc được trả thủ công hay qua cổng nào. `MANUAL` là flow cũ (sale confirm bằng tay) — vẫn giữ nguyên để fallback. |
| `vnpayTxnRef` | `String` unique sparse, max 100 | `vnp_TxnRef` gửi sang VNPay — chúng ta sinh theo pattern `DEP-{depositCode}-{randomSuffix}` để tra ngược được. Index unique sparse để chặn double-charge. |
| `vnpayTransactionNo` | `String`, max 50 | `vnp_TransactionNo` do VNPay trả về sau khi khách thanh toán thành công. Chỉ có sau khi webhook/return URL về. |
| `vnpayBankCode` | `String`, max 20 | Ngân hàng khách thực tế dùng (NCB, VCB, MB…). VNPay trả về trong response. |
| `vnpayPayDate` | `Date` | `vnp_PayDate` do VNPay parse từ string `yyyyMMddHHmmss` — mốc thời gian khách hoàn tất thanh toán tại VNPay. |
| `vnpayResponseCode` | `String`, max 10 | `vnp_ResponseCode` thô ('00' = success, các mã khác là lỗi) để debug. |

Không thêm index mới ngoài `vnpayTxnRef` (unique sparse). Index hiện có `uniq_active_hold_per_car` vẫn là barrier chính.

### 2.2. Collection mới `vnpay_ipn_logs` (idempotency + audit)

VNPay IPN có thể gọi **nhiều lần** cho cùng 1 giao dịch (retry nếu BE phản hồi không đúng format). Chúng ta phải idempotent — ghi log mọi IPN đã xử lý.

```js
{
  _id,
  vnpTxnRef: String,        // index
  vnpTransactionNo: String,
  vnpResponseCode: String,
  vnpSecureHash: String,    // raw hash gửi tới, để audit
  rawQuery: Object,         // toàn bộ query string VNPay gửi
  depositId: ObjectId,      // ref → deposits._id
  verifiedSignature: Boolean,
  outcome: String,          // enum ['APPLIED', 'DUPLICATE', 'INVALID_SIGNATURE', 'DEPOSIT_NOT_FOUND', 'DEPOSIT_INVALID_STATE', 'AMOUNT_MISMATCH']
  responseToVnpay: Object,  // { RspCode, Message } đã trả về
  receivedAt: Date,
  processedMs: Number,      // benchmark
}
```

Index:
- `{ vnpTxnRef: 1, vnpTransactionNo: 1 }` — unique partial `verifiedSignature: true` → mỗi IPN chữ ký hợp lệ chỉ apply 1 lần.
- `{ receivedAt: -1 }` TTL 90 ngày.

---

## 3. Luồng người dùng

### 3.1. Happy path (khách đặt cọc thành công qua VNPay)

```
Khách              FE                       BE                       VNPay (sandbox)       Job/DB
 │                  │                        │                        │                     │
 │ Chọn xe, bấm     │                        │                        │                     │
 │ "Đặt cọc"        │                        │                        │                     │
 ├─────────────────>│                        │                        │                     │
 │                  │ POST /deposits         │                        │                     │
 │                  │ (carId, amount, pay=VNPAY)                      │                     │
 │                  ├───────────────────────>│                        │                     │
 │                  │                        │ 1. Tạo Deposit         │                     │
 │                  │                        │ 2. Reserve Car         │                     │
 │                  │                        │ 3. Sinh vnp_TxnRef     │                     │
 │                  │                        │ 4. Build payment URL   │                     │
 │                  │                        │    với HMAC-SHA512     │                     │
 │                  │<───────────────────────┤                        │                     │
 │                  │ 201 { depositId, paymentUrl }                   │                     │
 │ Redirect         │                        │                        │                     │
 │ sang paymentUrl  │                        │                        │                     │
 │<─────────────────┤                        │                        │                     │
 │                                                                   │                     │
 │ Chọn ngân hàng NCB, nhập OTP sandbox, submit                      │                     │
 ├────────────────────────────────────────────────────────────────────>│                     │
 │                                                                   │                     │
 │                  │                        │  IPN (POST query string)                     │
 │                  │                        │<───────────────────────┤                     │
 │                  │                        │ 1. Verify HMAC         │                     │
 │                  │                        │ 2. Lookup deposit      │                     │
 │                  │                        │ 3. Check amount match  │                     │
 │                  │                        │ 4. Set DEPOSIT_PAID    │                     │
 │                  │                        │ 5. Write ipn_log       │                     │
 │                  │                        │ 6. Return {RspCode:00} │                     │
 │                  │                        ├───────────────────────>│                     │
 │                                                                   │                     │
 │ VNPay redirect về returnUrl                                       │                     │
 │<───────────────────────────────────────────────────────────────────┤                     │
 │                  │ GET /deposits/vnpay-return?vnp_...              │                     │
 │                  ├───────────────────────>│                        │                     │
 │                  │                        │ Verify HMAC lại        │                     │
 │                  │                        │ Lookup deposit         │                     │
 │                  │                        │ (có thể đã PAID từ IPN)│                     │
 │                  │<───────────────────────┤                        │                     │
 │                  │ 302 → /dat-coc/:id/thanh-cong                   │                     │
 │ Thấy trang       │                        │                        │                     │
 │ "Thanh toán      │                        │                        │                     │
 │ thành công"      │                        │                        │                     │
 │                                                                                         │
 │                  │ Poll GET /deposits/:id mỗi 3s trong 30s                               │
 │                  │ hoặc WebSocket subscribe                                              │
 │                  │                        │                        │                     │
```

**Điểm then chốt về thứ tự:**
1. IPN (webhook server-to-server) đến **TRƯỚC** return URL trong ~95% trường hợp. Khi return URL về, `status` đã là `DEPOSIT_PAID`.
2. 5% còn lại (mạng chậm, VNPay xử lý lâu): return URL về trước IPN. Return URL **không được** tự update DB — chỉ hiển thị trang "chờ xác nhận", FE poll cho tới khi `paymentStatus === 'DEPOSIT_PAID'` hoặc timeout 60s.
3. Nếu timeout 60s mà vẫn chưa có IPN → FE show "Giao dịch đang được xử lý, vui lòng đợi trong 1–2 phút", đồng thời job đối soát `vnpayReconcileJob` sẽ chạy mỗi 5 phút gọi `vnp_querydr` để query trạng thái → self-heal.

### 3.2. Các luồng lỗi

| Tình huống | VNPay `vnp_ResponseCode` | BE xử lý |
|---|---|---|
| Khách hủy giữa chừng, bấm back ở trang VNPay | `24` | Return URL hiển thị "Khách hủy giao dịch". Deposit vẫn `PENDING_PAYMENT`. Khách có thể bấm "Thanh toán lại" → sinh `vnpTxnRef` mới (hủy cái cũ bằng cách append suffix). |
| Khách nhập sai OTP nhiều lần | `75`, `79` | Tương tự trên. |
| Khách thanh toán nhưng amount không khớp (vd FE bị tamper) | IPN về với amount lệch | BE verify → trả `{RspCode:04, Message:"Invalid amount"}` cho VNPay → VNPay báo failed cho khách. Deposit vẫn PENDING. Ghi `outcome: AMOUNT_MISMATCH` để audit. |
| Deposit đã EXPIRED trước khi IPN về | — | Verify HMAC ok nhưng `deposit.status === 'EXPIRED'`. Trả `{RspCode:02, Message:"Order already confirmed"}`. Log `outcome: DEPOSIT_INVALID_STATE`. Mark `reviewRequired=true` + `reviewNote: 'VNPay IPN sau EXPIRED — cần kiểm tra'` để sale biết refund thủ công. |
| VNPay gửi IPN cho `vnpTxnRef` không tồn tại (tấn công) | — | Trả `{RspCode:01, Message:"Order not found"}`. Log `outcome: DEPOSIT_NOT_FOUND`. |
| IPN trùng (VNPay retry) | — | Query `vnpay_ipn_logs` theo `vnpTxnRef + vnpTransactionNo + verifiedSignature:true` → tồn tại → trả lại `responseToVnpay` cũ. Log `outcome: DUPLICATE`. Không chạm DB. |
| Chữ ký sai | — | Trả `{RspCode:97, Message:"Invalid signature"}`. Log `outcome: INVALID_SIGNATURE`. Alert monitoring (có thể đang bị attack). |

---

## 4. Config & Env vars mới

Thêm vào `.env.example`:

```bash
# VNPay sandbox integration (KAN-99)
VNPAY_TMN_CODE=            # Terminal code cấp bởi VNPay sandbox, VD: 2QXUI4J4
VNPAY_HASH_SECRET=         # Secret key để HMAC-SHA512, bảo vệ như password
VNPAY_PAYMENT_URL=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
VNPAY_QUERY_URL=https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
VNPAY_RETURN_URL=https://staging.trustcar.vn/dat-coc/vnpay-return
VNPAY_IPN_URL=https://staging-api.trustcar.vn/api/v1/deposits/vnpay-ipn
VNPAY_IP_WHITELIST=118.69.126.44,113.52.45.78  # IP VNPay gọi IPN (lấy từ doc, cập nhật nếu đổi)
VNPAY_TIMEOUT_MINUTES=15   # Khách phải hoàn tất trong 15 phút ở trang VNPay
VNPAY_RECONCILE_INTERVAL_MS=300000  # 5 phút
```

`src/config/vnpay.js` đọc env, expose qua `getVnpayConfig()` tương tự `getDepositSettings()`. **Khi chưa có `VNPAY_TMN_CODE` + `VNPAY_HASH_SECRET`**, endpoint `POST /deposits/:id/vnpay-url` trả `503 VNPAY_NOT_CONFIGURED` để fallback về flow MANUAL — không crash server.

**Secret handling:**
- `VNPAY_HASH_SECRET` KHÔNG BAO GIỜ log, không trả về API, không commit. Thêm vào `.gitignore` check + pre-commit hook `git-secrets` nếu có thời gian.
- Tất cả log của IPN phải mask hash: hiển thị `vnp_SecureHash: "abc…xyz (64 chars)"`.

---

## 5. Backend Implementation

### 5.1. File mới

| File | Mục đích | Line count ước tính |
|---|---|---|
| `src/config/vnpay.js` | Config loader + validate env | 60 |
| `src/services/vnpayService.js` | Build payment URL, verify signature, call `vnp_querydr` | 180 |
| `src/services/vnpayIpnService.js` | Process IPN (state transition + log) | 200 |
| `src/controllers/vnpayController.js` | Handle 3 endpoint HTTP | 90 |
| `src/routes/vnpayRoutes.js` | Mount routes | 50 |
| `src/models/VnpayIpnLog.js` | Collection idempotency log | 50 |
| `src/jobs/vnpayReconcileJob.js` | Self-heal gọi queryDR mỗi 5 phút | 120 |
| `tests/services/vnpayService.test.js` | Unit test HMAC + URL building | 150 |
| `tests/routes/vnpayIpn.test.js` | Integration test IPN đủ 7 outcome | 250 |

### 5.2. File sửa (nhỏ, không phá API cũ)

| File | Sửa gì |
|---|---|
| `src/models/Deposit.js` | Thêm 6 field schema (mục 2.1) |
| `src/services/depositService.js` | Thêm option `paymentProvider` cho `createDeposit`; hàm mới `createVnpayPaymentIntent(depositId)` |
| `src/routes/depositRoutes.js` | Thêm Joi `paymentProvider: Joi.string().valid('MANUAL','VNPAY').default('MANUAL')` |
| `src/constants/depositConstants.js` | Thêm enum `PaymentProvider = { MANUAL, VNPAY }`; error codes mới `VNPAY_NOT_CONFIGURED`, `VNPAY_ALREADY_PAID`, `VNPAY_AMOUNT_MISMATCH` |
| `src/routes/index.js` | Mount `/deposits/vnpay-*` trước `/deposits/:id` để tránh conflict |
| `src/server.js` | Start `vnpayReconcileJob` sau khi Mongo connected |
| `.env.example` | Thêm block VNPay |

### 5.3. API Contract

#### POST `/api/v1/deposits/:id/vnpay-url`

Khởi tạo thanh toán. Khách phải đã có `Deposit` với `status=PENDING_PAYMENT` + `paymentProvider=VNPAY`.

**Auth:** JWT (owner của deposit hoặc staff).
**Rate limit:** 5 req/phút/user — khách có thể tạo lại URL sau khi hủy ở VNPay.

**Request body:** (không cần, thông tin lấy từ deposit)

**Response 200:**
```json
{
  "paymentUrl": "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?vnp_Amount=1000000000&vnp_Command=pay&…&vnp_SecureHash=abc…",
  "vnpTxnRef": "DEP-DC-261120-ABC123-1700475600",
  "expiresInMinutes": 15,
  "returnUrl": "https://staging.trustcar.vn/dat-coc/vnpay-return"
}
```

**Lỗi:**
- `409 VNPAY_ALREADY_PAID` nếu `paymentStatus !== 'UNPAID'`.
- `409 DEPOSIT_INVALID_STATE` nếu `status !== 'PENDING_PAYMENT'`.
- `503 VNPAY_NOT_CONFIGURED` nếu thiếu env.

**Logic:**
1. Lấy deposit, verify ownership.
2. Sinh `vnpTxnRef = "DEP-${depositCode}-${Date.now()}"` (ví dụ `DEP-DC-261120-ABC123-1700475600`).
3. Update deposit: `$set: { vnpayTxnRef, paymentProvider: 'VNPAY' }`.
4. Build URL theo spec VNPay (mục 5.4).
5. Trả về.

#### GET `/api/v1/deposits/vnpay-ipn`

Webhook VNPay → server. Theo doc VNPay v2 (Jan 2024) dùng **GET** với query string, **không phải POST**. Response phải là JSON `{"RspCode":"00","Message":"Confirm Success"}`.

**Auth:** Không (public). IP whitelist check trong middleware.
**Rate limit:** Không (VNPay có thể retry nhiều).

**Request query params:** 20+ fields VNPay gửi — tất cả lấy raw, KHÔNG dùng validator Joi strict vì VNPay có thể thêm field mới.

**Response 200 (luôn luôn 200 kể cả khi có lỗi — HTTP status khác sẽ khiến VNPay retry mãi):**
```json
{ "RspCode": "00", "Message": "Confirm Success" }
```

**Các RspCode:**
| Code | Nghĩa |
|---|---|
| 00 | Confirm Success — đã apply |
| 01 | Order not found |
| 02 | Order already confirmed |
| 04 | Invalid amount |
| 97 | Invalid signature |
| 99 | Unknown error |

#### GET `/api/v1/deposits/vnpay-return`

Khách redirect về từ VNPay. **Không** update DB (IPN lo), chỉ verify HMAC rồi redirect tiếp về FE.

**Response:** 302 → FE route:
- Success: `/dat-coc/{depositId}/thanh-cong?txn={vnpTransactionNo}`
- Khách hủy: `/dat-coc/{depositId}/da-huy`
- Thất bại: `/dat-coc/{depositId}/that-bai?code={vnp_ResponseCode}`
- Invalid signature: `/dat-coc/that-bai?error=INVALID_SIGNATURE`

### 5.4. Build Payment URL (quy tắc VNPay)

```js
// Pseudo code — chi tiết trong vnpayService.js

const params = {
  vnp_Version: '2.1.0',
  vnp_Command: 'pay',
  vnp_TmnCode: config.tmnCode,
  vnp_Amount: deposit.depositAmount * 100,  // VND x 100 theo spec
  vnp_CurrCode: 'VND',
  vnp_TxnRef: vnpTxnRef,
  vnp_OrderInfo: `Dat coc xe ${deposit.carVehicleCode}`,  // ASCII only, không dấu
  vnp_OrderType: '250000',  // Topup = 250000 là code "khác" phù hợp cho deposit
  vnp_Locale: 'vn',
  vnp_ReturnUrl: config.returnUrl,
  vnp_IpAddr: req.ip,
  vnp_CreateDate: dayjs().format('YYYYMMDDHHmmss'),
  vnp_ExpireDate: dayjs().add(15, 'minute').format('YYYYMMDDHHmmss'),
};

// Sort key alphabetically — bắt buộc
const sorted = Object.keys(params).sort().reduce((acc, k) => ({ ...acc, [k]: params[k] }), {});

// URL-encode theo spec của VNPay — dùng qs.stringify chuẩn (không encode space thành +)
const signData = qs.stringify(sorted, { encode: false });
const hmac = crypto.createHmac('sha512', config.hashSecret);
const signed = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');

const paymentUrl = `${config.paymentUrl}?${qs.stringify(sorted, { encode: true })}&vnp_SecureHash=${signed}`;
```

**Gotcha đã biết (từ doc + Stack Overflow):**
- Phải sort key **trước khi** stringify, không được sort ngược.
- Dùng `Buffer.from(signData, 'utf-8')` thay vì truyền string trực tiếp — Node `createHmac().update()` default encoding là utf-8 nhưng ghi rõ để portable.
- `vnp_Amount` = VND × 100 (vì VNPay internal dùng int, không dùng float).
- `vnp_OrderInfo` **không được có dấu tiếng Việt** (ASCII only), nếu có sẽ fail HMAC do encoding không nhất quán.
- `vnp_IpAddr` phải là IP thật của khách (dùng `req.ip` sau khi set `app.set('trust proxy', true)`), không được là IP server.

### 5.5. Verify IPN (quy tắc VNPay)

```js
// Pseudo code — chi tiết trong vnpayService.js

function verifyVnpayHash(query) {
  const { vnp_SecureHash, vnp_SecureHashType, ...rest } = query;
  const sorted = Object.keys(rest).sort().reduce((acc, k) => ({ ...acc, [k]: rest[k] }), {});
  const signData = qs.stringify(sorted, { encode: false });
  const hmac = crypto.createHmac('sha512', config.hashSecret);
  const expected = hmac.update(Buffer.from(signData, 'utf-8')).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(vnp_SecureHash, 'hex'), Buffer.from(expected, 'hex'));
}
```

**Lưu ý:**
- **`crypto.timingSafeEqual`** để chống timing attack (yêu cầu buffer cùng length — nếu lệch thì return false ngay, không throw).
- Loại cả `vnp_SecureHash` **và** `vnp_SecureHashType` khỏi payload trước khi tính (gotcha trong doc VNPay — `vnp_SecureHashType` là legacy từ v1 nhưng vẫn gửi).

### 5.6. State Transition khi IPN success

Dùng conditional update tương tự `confirm-payment` hiện tại:

```js
// Trong vnpayIpnService.js, bên trong runDepositAtomic
const now = new Date();
const updated = await Deposit.findOneAndUpdate(
  {
    _id: depositId,
    status: DepositStatus.PENDING_PAYMENT,
    paymentStatus: DepositPaymentStatus.UNPAID,
    vnpayTxnRef: vnp_TxnRef,  // thêm guard — phải đúng txnRef này
  },
  {
    $set: {
      status: DepositStatus.DEPOSIT_PAID,
      paymentStatus: DepositPaymentStatus.DEPOSIT_PAID,
      paidAt: now,
      paymentConfirmedBy: null,  // null = system (not staff)
      paymentReference: vnp_TransactionNo,
      paymentNote: `VNPay sandbox • Bank: ${vnp_BankCode}`,
      vnpayTransactionNo: vnp_TransactionNo,
      vnpayBankCode: vnp_BankCode,
      vnpayPayDate: parseVnpDate(vnp_PayDate),
      vnpayResponseCode: '00',
      // Extend deadline nếu DEPOSIT_PAID_HOLD_HOURS > 0
      ...(settings.paidHoldMs > 0 && { expiresAt: new Date(now.getTime() + settings.paidHoldMs) }),
    },
    $push: {
      history: {
        action: DepositAction.PAYMENT_CONFIRMED,
        at: now,
        actorId: null,  // system
        result: 'SUCCESS',
        note: `Tự động qua VNPay (TxnNo ${vnp_TransactionNo})`,
      },
    },
  },
  { new: true },
);

if (!updated) {
  // Deposit không ở trạng thái mong đợi — có thể đã bị cancel/expire
  return { outcome: 'DEPOSIT_INVALID_STATE', rspCode: '02' };
}

await ActivityLog.create({
  eventType: ActivityEventType.DEPOSIT_PAYMENT_CONFIRMED,
  resourceId: updated._id,
  actorId: null,
  metadata: { source: 'VNPAY', vnpTransactionNo: vnp_TransactionNo, amount: updated.depositAmount },
});
```

---

## 6. Frontend Implementation

### 6.1. File mới

| File | Mục đích |
|---|---|
| `features/deposits/pages/VnpayReturnPage.jsx` | Route `/dat-coc/vnpay-return` — hiển thị kết quả sau khi quay về từ VNPay |
| `features/deposits/pages/DepositSuccessPage.jsx` | `/dat-coc/:id/thanh-cong` — "Đặt cọc thành công" với QR mã, link xe |
| `features/deposits/components/PaymentProviderSelector.jsx` | Chọn cổng thanh toán (hiện tại chỉ VNPay + "Chuyển khoản thủ công") |
| `features/deposits/components/PaymentPollingStatus.jsx` | Poll `GET /deposits/:id` mỗi 3s để update status realtime |
| `features/deposits/api/vnpayApi.js` | `createVnpayPaymentUrl(depositId)` |

### 6.2. Flow UI

1. Trang `/xe/:code` — khách bấm "Đặt cọc giữ xe".
2. Modal hiện: form chọn `paymentProvider` (radio: VNPay / Chuyển khoản), hiển thị số tiền cọc theo config (gọi `GET /deposits/policy?carId=…`).
3. Khách submit → `POST /deposits` tạo deposit với `paymentProvider=VNPAY`.
4. BE trả về `{ depositId }`. FE gọi `POST /deposits/:id/vnpay-url` → nhận `paymentUrl`.
5. FE `window.location.href = paymentUrl`.
6. Khách thao tác trên trang VNPay (sandbox có hướng dẫn test OTP: `123456` cho bank NCB).
7. VNPay redirect về `/dat-coc/vnpay-return?vnp_…`.
8. `VnpayReturnPage` parse query, call `GET /deposits/vnpay-return` (chính endpoint BE verify) → BE redirect 302 tiếp đến `/dat-coc/:id/thanh-cong`.
9. `DepositSuccessPage` hiển thị trạng thái, poll cho đến khi `paymentStatus === 'DEPOSIT_PAID'`.

### 6.3. UX tinh chỉnh

- Trang thanh toán hiển thị **countdown 15 phút** — nếu quá hạn vẫn chưa quay về, show button "Thử lại" (gọi lại `POST /deposits/:id/vnpay-url` sinh txnRef mới).
- Nếu khách bấm back ở trang VNPay rồi vào lại `/dat-coc/:id`, FE phải check `paymentStatus`:
  - `UNPAID` → hiển thị lại nút "Thanh toán qua VNPay".
  - `DEPOSIT_PAID` → chuyển sang trang success.
- Thêm tooltip giải thích "Số tiền cọc 5% giá xe theo quy định showroom" (lấy từ `/deposits/policy`).

---

## 7. Bảo mật

| Lớp | Biện pháp |
|---|---|
| Transport | Tất cả URL VNPay là HTTPS. `.env.example` không có secret thật. |
| Signature | HMAC-SHA512 cả 2 chiều, `timingSafeEqual` khi verify. |
| IP whitelist | IPN middleware check `req.ip` thuộc `VNPAY_IP_WHITELIST`. Return URL không whitelist vì khách đến từ VNPay qua browser (IP khác). |
| Idempotency | Unique partial `{vnpTxnRef, vnpTransactionNo} where verifiedSignature:true` trên `vnpay_ipn_logs`. |
| Amount tampering | BE verify `vnp_Amount / 100 === deposit.depositAmount`. Lệch → trả `RspCode:04`. |
| Replay attack | Same `vnpTxnRef` + `vnpTransactionNo` trả về IPN cũ, không chạm DB. |
| Log leak | Không log `vnp_SecureHash` full, không log `VNPAY_HASH_SECRET`. |
| Rate limit | `POST /deposits/:id/vnpay-url` 5/phút/user. IPN không rate limit (VNPay retry). |
| CSRF | Return URL dùng `vnp_TxnRef` + HMAC để verify khách thật, không dùng session CSRF token (VNPay không gửi CSRF). |
| Audit | Mọi state transition do VNPay trigger → ActivityLog `source: 'VNPAY'`. |

**Threat model ngắn:**
- *Attacker tạo IPN giả* → signature fail → RspCode 97 → log alert.
- *Attacker tamper amount trên URL* → VNPay sandbox detect (VNPay verify trước) hoặc BE detect khi IPN về → RspCode 04.
- *Attacker spam `/vnpay-url`* → rate limit 5/phút/user chặn.
- *Replay IPN* → unique index chặn.
- *Compromised staff account confirm payment thủ công cho giao dịch VNPay fake* → vẫn an toàn vì `paymentReference` sẽ không match `vnpTransactionNo`, audit log có `source: 'MANUAL'` thay vì `VNPAY`.

---

## 8. Test plan

### 8.1. Unit (Jest)

| File | Test case |
|---|---|
| `vnpayService.test.js` | buildPaymentUrl sort key đúng, HMAC consistent với sample từ doc VNPay |
| | verifyIpnSignature pass với sample success, fail với tampered hash, fail với missing hash |
| | parseVnpDate convert `20261120123045` → Date object UTC+7 |

### 8.2. Integration (Supertest)

| File | Test case |
|---|---|
| `vnpayIpn.test.js` | IPN success → Deposit = DEPOSIT_PAID + log APPLIED + RspCode 00 |
| | IPN duplicate → không touch DB, log DUPLICATE, trả lại response cũ |
| | IPN invalid signature → RspCode 97, log INVALID_SIGNATURE |
| | IPN amount mismatch → RspCode 04, log AMOUNT_MISMATCH, deposit vẫn UNPAID |
| | IPN cho deposit EXPIRED → RspCode 02, `reviewRequired=true` |
| | IPN cho txnRef không tồn tại → RspCode 01 |
| | IPN race condition: 2 IPN đồng thời → chỉ 1 applied |
| `vnpayUrl.test.js` | POST /vnpay-url trả paymentUrl valid, chứa vnp_TxnRef đã lưu |
| | POST /vnpay-url khi env thiếu → 503 VNPAY_NOT_CONFIGURED |
| | POST /vnpay-url khi deposit đã PAID → 409 VNPAY_ALREADY_PAID |
| `vnpayReturn.test.js` | Return URL với signature hợp lệ + success → 302 success page |
| | Return URL với signature fail → 302 error page |
| | Return URL với responseCode=24 (khách hủy) → 302 cancel page |

### 8.3. E2E (manual trên staging)

Test script 10 bước (sẽ document riêng ở `TrustCar-BackEnd/docs/KAN-99-e2e-test-script.md`):

1. Tạo 1 car AVAILABLE với giá 500tr.
2. Login customer, bấm "Đặt cọc" với VNPay — expect modal.
3. Submit → redirect sang sandbox.vnpayment.vn.
4. Chọn bank NCB → OTP `123456` → success.
5. Expect redirect về `/dat-coc/:id/thanh-cong` trong 5s.
6. Expect `GET /deposits/:id` trả `paymentStatus: DEPOSIT_PAID`.
7. Login admin → `/admin/deposits/:id` → xem history có `PAYMENT_CONFIRMED by SYSTEM`.
8. Negative: khách hủy giữa chừng → về trang cancel, deposit vẫn PENDING, có thể thử lại.
9. Negative: đợi quá 15 phút ở trang VNPay → về thì expired, có nút "Thử lại".
10. Negative: đổi URL params rồi gửi lại → verify fail, show "Giao dịch không hợp lệ".

### 8.4. Load test (optional nếu còn thời gian)

- k6 script 20 concurrent user tạo URL + thanh toán → đo p95 response time POST /vnpay-url < 300ms.

---

## 9. Phụ thuộc & Rủi ro

### Phụ thuộc
- **KAN-49 staging deployed** (đã done) — cần HTTPS public URL cho IPN. Không chạy sandbox từ localhost được (VNPay không call `localhost`). Dùng Render/Vercel staging domain.
- **KAN-22 merge xong** (đã done) — Deposit model + service là nền.
- **Mongoose transaction** — hiện tại standalone không có transaction thật. Logic viết tuần tự conditional updates, chấp nhận trade-off đã note trong KAN-22 doc. Nếu lên Atlas production thì nâng cấp thành transaction.

### Rủi ro

| Rủi ro | Impact | Mitigation |
|---|---|---|
| VNPay sandbox đổi IP → IPN bị block | HIGH | Thêm fallback: nếu IP không match + signature đúng, log warning rồi vẫn xử lý; cron reconcile check mỗi 5 phút |
| Signature mismatch do encoding mismatch Node vs Java (VNPay backend Java) | HIGH | Dùng sample URL trong doc VNPay test trước khi merge; có unit test với fixture từ doc |
| Khách disable cookie 3rd party → return URL lose session | MED | Dùng URL params (depositId trong path) thay vì session để lookup |
| Deposit expire trong khi khách đang ở VNPay (vì `holdHours=24h` nhưng `VNPAY_TIMEOUT_MINUTES=15`) | LOW | 15p << 24h nên khả năng rất thấp; tuy vậy UX cần hiện countdown. Nếu expired, IPN về sẽ ghi reviewRequired. |
| Hash secret leak qua `.env` commit | CRITICAL | `.gitignore` check, pre-commit hook, không share secret qua Zalo |

---

## 10. Rollout

### Phase 1 (03/12–05/12)
- Code + unit test. Merge sau khi QA của Tú duyệt. Feature flag `FEATURE_VNPAY=false` trong env.
- Deploy staging với `FEATURE_VNPAY=true`.
- Internal test đủ 10 case E2E.

### Phase 2 (06/12–07/12)
- Mời 2 thành viên team test trên staging (Bình + Nguyên) → report bug.
- Fix bug tìm được.

### Phase 3 (08/12)
- Demo hội đồng. Có clip E2E 2 phút để backup nếu network staging chậm.
- Prepare slide note "Tại sao VNPay sandbox không phải live": hợp lệ cho đồ án, VNPay có hợp đồng merchant riêng + phí thật.

### Rollback plan
- Set `FEATURE_VNPAY=false` → FE ẩn option "VNPay", chỉ hiển thị "Chuyển khoản thủ công". Flow MANUAL vẫn hoạt động bình thường. Không ảnh hưởng deposit đã tạo.

---

## 11. Definition of Done

- [ ] Code merge, pass CI (jest + lint).
- [ ] 10 unit test + 7 integration test + 10 E2E step đều pass.
- [ ] Deploy staging, feature flag ON.
- [ ] Doc này link trong README.
- [ ] 2 teammate test được 1 cycle end-to-end thành công.
- [ ] Clip demo 2 phút save vào Google Drive của team.
- [ ] Jira KAN-99 move to Done kèm screenshot thành công.

---

## 12. Câu hỏi còn mở (ít quan trọng)

- Có cần hiển thị cả "Giao dịch chờ VNPay xác nhận" vs "Đã VNPay xác nhận nhưng chờ showroom thu cả xe" trên UI customer không, hay chỉ cần 1 status gộp?
- Phần "thanh toán toàn bộ giá xe" sau khi `DEPOSIT_PAID` vẫn chạy MANUAL — sprint sau có cần expose VNPay cho phần này không? (Nhắc Tú: VNPay sandbox limit 10M VND/giao dịch, nên xe cũ > 10M sẽ không test được qua VNPay full payment — đó cũng là lý do KAN-99 chỉ scope deposit.)
- Có cần gửi email xác nhận cho khách khi IPN success không? Tận dụng `emailLogService` + template `deposit-vnpay-success`.

Trả lời các câu trên có thể delay sau khi SPEC v1 implement xong.
