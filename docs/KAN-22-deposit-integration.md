# KAN-22 – Car Deposit & Online Hold (Backend)

Tài liệu module đặt cọc giữ xe. **Toàn bộ là file mới, không file cũ nào bị sửa.**

## 1. Database

| Hạng mục | Hiện trạng (kiểm tra chỉ đọc ngày 11/11/2026) |
|---|---|
| Hệ quản trị | MongoDB 8.3.2, `mongodb://127.0.0.1:27017`, db `trustcar` |
| Topology | **STANDALONE**, không hỗ trợ transaction nhiều document |
| ERD | **Không có** bảng Deposit (30 bảng, không bảng nào chứa tiền cọc). `Sale Record` là bảng gần nhất nhưng chỉ ghi giao dịch bán **đã chốt** |
| Collection `deposits` | **Chưa tồn tại** (28 collection hiện có) |
| Model | `src/models/Deposit.js` (mới) |

### Tạo collection (cần bạn cho phép trước khi chạy)
```bash
node src/seeders/createDepositsCollection.js           # dry-run: chỉ đọc và in kế hoạch
node src/seeders/createDepositsCollection.js --apply   # tạo collection + validator + 8 index
```
Script chạy lại nhiều lần vẫn an toàn (idempotent). Nó không chèn, sửa hay xóa dữ liệu nào. Nếu dữ liệu sẵn có sẽ vi phạm unique index, script dừng lại. Nếu không chạy script, Mongoose cũng tự tạo collection và index khi bản ghi đầu tiên được ghi (`autoIndex` mặc định đang bật), nhưng khi đó không có validator `$jsonSchema`.

### Cấu trúc `deposits`
| Nhóm | Trường |
|---|---|
| Định danh | `_id`, `depositCode` (DC-YYMMDD-XXXXXX, unique) |
| Quan hệ | `carId → cars`, `userId → users` (tài khoản khách, lấy từ JWT), `customerId → customers` (hồ sơ showroom của tài khoản đó, giống Sale Record) |
| Snapshot | `carVehicleCode`, `carTitle`, `carPriceSnapshot` |
| Tiền | `depositAmount` (VND, số nguyên), `currency` |
| Trạng thái | `status` (giữ xe), `paymentStatus` (tiền), `holdActive` |
| Mốc thời gian | `createdAt`, `reservedAt`, `expiresAt`, `paidAt`, `completedAt`, `cancelledAt`, `expiredAt`, `refundedAt`, `updatedAt` |
| Chứng từ | `paymentReference/Note`, `fullPaymentReference/Note`, `refundAmount/Reference/Note`, `cancelReason` |
| Người xử lý | `paymentConfirmedBy`, `completedBy`, `cancelledBy`, `refundedBy` → users |
| Đối soát | `carStatusChangedAt`, `carReleasedOnClose`, `reviewRequired`, `reviewNote` |
| Nhật ký | `history[]` gồm action, at, actorId, result, note; chỉ ghi thêm, không sửa |

Quan hệ: 1 User có nhiều Deposit, 1 Car có nhiều Deposit. **Mỗi Car chỉ có tối đa 1 Deposit đang `holdActive`**.

### Index
| Tên | Khóa | Mục đích |
|---|---|---|
| `uniq_depositCode` | `{depositCode}` unique | Mã đặt cọc không trùng |
| **`uniq_active_hold_per_car`** | `{carId}` unique, partial `holdActive:true` | **Chặn ở tầng DB: một xe chỉ có một lượt giữ đang hoạt động** |
| `car_history` | `{carId, createdAt:-1}` | Lịch sử cọc của từng xe |
| `user_history` | `{userId, createdAt:-1}` | Lịch sử cọc của khách |
| `customer_active_holds` | `{customerId, holdActive}` | Giới hạn số xe giữ cùng lúc |
| `expiry_scan` | `{status, expiresAt}` | Job hết hạn |
| `payment_status_list` | `{paymentStatus, createdAt:-1}` | Lọc cho nhân viên |
| `active_holds_reconcile` | `{holdActive, reservedAt}` | Job đối soát |

## 2. Vòng đời

```
                 confirm-payment              complete (xe RESERVED→SOLD)
PENDING_PAYMENT ───────────────> DEPOSIT_PAID ───────────────────────────> COMPLETED
 paymentStatus: UNPAID            DEPOSIT_PAID                              FULLY_PAID
      │  ╲                              │  ╲
      │   ╲ cancel (khách/NV)           │   ╲ cancel (NV)
      │    ╲                            │    ╲
      │  quá hạn: EXPIRED                │  quá hạn: EXPIRED
      ▼   (xe RESERVED→AVAILABLE)        ▼   (xe RESERVED→AVAILABLE)
 CANCELLED/EXPIRED + UNPAID      CANCELLED/EXPIRED + REFUND_PENDING ──refund (ADMIN)──> REFUNDED
```

- **Giữ xe**: từ `reservedAt`, tức lúc khách tạo yêu cầu và xe chuyển RESERVED trong cùng request, tới `expiresAt = reservedAt + 24h`.
- **Hiểu theo đúng Jira** (*"sau 24h khách không thanh toán đủ → hủy cọc, xe về AVAILABLE"*): khách phải **thanh toán đủ** trước `expiresAt`. Nếu chỉ mới trả cọc mà quá hạn, lượt giữ hết hạn và tiền cọc chuyển sang `REFUND_PENDING`.
- **Phương án thay thế** (cần nghiệp vụ chốt): đặt `DEPOSIT_PAID_HOLD_HOURS=N` thì khi nhân viên xác nhận cọc, hạn được kéo dài thành `paidAt + N giờ`.
- Thanh toán **tiền cọc** (`DEPOSIT_PAID`) và **thanh toán đủ** (`FULLY_PAID`) là hai trạng thái tách biệt.

## 3. Chống đặt cọc trùng / nhất quán

1. Deposit được tạo **trước**, rồi mới cập nhật xe. Unique partial index chặn bản ghi thứ hai nên request đến sau nhận **409** `DEPOSIT_CAR_ALREADY_RESERVED`.
2. Xe chỉ chuyển AVAILABLE → RESERVED khi `status = AVAILABLE` và `price` vẫn đúng giá đã đọc. Nếu không khớp, Deposit vừa tạo bị xóa để bù trừ, và request trả 409. Vì vậy **không bao giờ có xe RESERVED mà không có Deposit**.
3. Mọi chuyển trạng thái Deposit đều có điều kiện theo trạng thái hiện tại, nên hết hạn, hủy, xác nhận và hoàn tất không thể cùng thành công trên một bản ghi.
4. Xe chỉ được trả về AVAILABLE hoặc chuyển SOLD khi **vẫn RESERVED với đúng mốc `statusChangedAt` do lượt giữ này ghi**. Xe đã SOLD không bao giờ quay lại AVAILABLE, và lượt giữ mới không bị ảnh hưởng.
5. **Replica set / Atlas**: toàn bộ chạy trong một transaction. **Standalone (DB hiện tại)**: chạy tuần tự các lệnh cập nhật có điều kiện, kèm bù trừ. Nếu tiến trình chết giữa chừng, job đối soát sẽ hoàn tất phần còn lại sau tối đa ~5 phút. Khuyến nghị chuyển sang **replica set** (kể cả replica set 1 node khi dev) hoặc **MongoDB Atlas** để có tính nguyên tử đầy đủ. Tôi **không** tự đổi cấu hình MongoDB.

## 4. Hết hạn 24h

- Thời hạn lưu trong DB (`expiresAt`). Không dùng `setTimeout` làm cơ chế chính.
- Job `src/jobs/depositExpiryJob.js` chạy 2 giây sau khi server khởi động, để xử lý các lượt hết hạn trong lúc server tắt. Sau đó job chạy mỗi `DEPOSIT_JOB_INTERVAL_MS` (60 giây).
- Các API đọc cũng tự cho hết hạn khi cần, nên trạng thái đúng ngay lúc đồng hồ về 0.
- Lượt `COMPLETED` không bị đụng tới.
- Đối soát: nếu trạng thái xe bị đổi ngoài luồng này, lượt giữ được đóng và gắn cờ `reviewRequired`. Ví dụ: chốt đơn qua `/manage/cars/:id/status` của KAN-18.

## 5. API (`/api/v1/deposits`)

| Method | Path | Quyền | Mô tả |
|---|---|---|---|
| GET | `/cars/:carKey/hold-status` | Public (optionalAuth) | `state`, `hold.expiresAt`, `serverTime`, `policy`. Không lộ người giữ; trả `isMine` + deposit khi chính khách đó giữ |
| POST | `/` | CUSTOMER | `{ carId, depositAmount, userId? }`. Danh tính lấy từ JWT; `userId` khác tài khoản đăng nhập thì trả **403** `DEPOSIT_USER_MISMATCH` |
| GET | `/me` | CUSTOMER | Lịch sử của khách (`status`, `paymentStatus`, phân trang) |
| GET | `/` | ADMIN, SALES_STAFF | Danh sách (`status, paymentStatus, carId, userId, depositCode, activeOnly, reviewRequired`) |
| GET | `/:id` | Chủ lượt cọc / nhân viên | Chi tiết (nhân viên xem thêm khách hàng, chứng từ, lịch sử) |
| PATCH | `/:id/cancel` | Khách (chỉ PENDING_PAYMENT) / nhân viên | Hủy, xe về AVAILABLE |
| PATCH | `/:id/confirm-payment` | ADMIN, SALES_STAFF | Đã nhận **tiền cọc** |
| PATCH | `/:id/complete` | ADMIN, SALES_STAFF | Đã nhận **đủ tiền xe**, xe chuyển SOLD |
| PATCH | `/:id/refund` | ADMIN | Ghi nhận đã hoàn cọc |

Mã lỗi: 404 `DEPOSIT_CAR_NOT_FOUND` / `DEPOSIT_NOT_FOUND`; 409 `DEPOSIT_CAR_ALREADY_RESERVED` / `DEPOSIT_CAR_SOLD` / `DEPOSIT_CAR_NOT_AVAILABLE` / `DEPOSIT_CAR_PRICE_CHANGED` / `DEPOSIT_CAR_STATE_CONFLICT` / `DEPOSIT_LIMIT_REACHED` / `DEPOSIT_INVALID_STATE` / `DEPOSIT_EXPIRED`; 422 `DEPOSIT_AMOUNT_INVALID`; 403 `PROFILE_INCOMPLETE` / `DEPOSIT_USER_MISMATCH`.

## 6. Thanh toán

`businessRules.js` mục **LI-03** ghi rõ *"[OUT OF SCOPE] Online Payments, Deposits & Refunds"*. Dự án không có cổng thanh toán, nên module **không giả lập thanh toán và không tạo giao dịch giả**. Khách chuyển khoản với nội dung là mã đặt cọc, hoặc nộp tại showroom; nhân viên kiểm tra rồi bấm xác nhận. Khi có cổng thanh toán sau này, chỉ cần gọi `confirmDepositPayment` / `completeDeposit` từ webhook đã xác thực chữ ký.

- **Thuộc KAN-22**: giữ xe, hết hạn, xác nhận thủ công tiền cọc và thanh toán đủ, ghi nhận hoàn cọc.
- **Ngoài KAN-22**: cổng thanh toán, tự đối soát sao kê ngân hàng, hợp đồng/Sale Record (thuộc luồng chốt đơn KAN-18 hiện có), mức phí phạt khi hoàn cọc.

## 7. Activity Log

Dùng model `ActivityLog` có sẵn qua import, không sửa. Mỗi lần tạo, xác nhận cọc, hoàn tất, hủy, hết hạn, hoàn cọc hay đối soát đều được ghi lại. Khi xe đổi trạng thái, `eventType` là `CAR_STATUS_CHANGED`; các trường hợp khác dùng `CAR_UPDATED`. Mỗi bản ghi chứa:
- `performedBy` và `performedByEmail`: ai thực hiện;
- `targetId` và `targetCode`: xe nào;
- `createdAt`: lúc nào;
- `changes`: trạng thái xe trước và sau;
- `metadata`: `{ module:'DEPOSIT', action, result, depositCode, depositAmount, depositStatus, paymentStatus, reservedAt, expiresAt, customerUserId }`;
- IP và user-agent.

## 8. Biến môi trường (tùy chọn, thêm vào `.env`, không đưa vào source)

```
DEPOSIT_HOLD_HOURS=24
DEPOSIT_PAID_HOLD_HOURS=0
DEPOSIT_MIN_AMOUNT=5000000
DEPOSIT_MIN_PERCENT=1
DEPOSIT_MAX_PERCENT=30
DEPOSIT_SUGGESTED_PERCENT=5
DEPOSIT_MAX_ACTIVE_PER_CUSTOMER=1
DEPOSIT_JOB_INTERVAL_MS=60000
DEPOSIT_BANK_NAME=
DEPOSIT_BANK_ACCOUNT_NUMBER=
DEPOSIT_BANK_ACCOUNT_NAME=
```
Các mức tiền là **đề xuất**, cần chủ nghiệp vụ chốt. Nếu để trống thông tin ngân hàng, giao diện hướng dẫn khách gọi hotline.

## 9. ⚠️ Tích hợp vào file cũ (CHƯA sửa, chờ bạn cho phép)

### 9.1 `src/routes/index.js` (bắt buộc)
```js
// cạnh các import route khác
import depositRoutes        from './depositRoutes.js';
// sau dòng router.use('/marketing', marketingRoutes);
router.use('/deposits', depositRoutes);
```

### 9.2 `src/server.js` (bắt buộc, để xe tự quay lại AVAILABLE) — ✅ đã nối
```js
// trong khối import
import { startDepositExpiryJob, stopDepositExpiryJob } from './jobs/depositExpiryJob.js';
// sau bước seed admin, trước app.listen()
startDepositExpiryJob();
// trong shutdown(), trước server.close()
stopDepositExpiryJob();
```
Lưu ý: repo không có `testDriveJob`/`startTestDriveJob` như bản nháp ban đầu giả định; job đặt cọc hiện là job nền duy nhất.

### 9.3 `src/models/index.js` (khuyến nghị)
```js
import Deposit from './Deposit.js';
// thêm Deposit vào khối export { ... }
```

### 9.4 `src/constants/appConstants.js` (tùy chọn)
Thêm `DEPOSIT_CREATED`, `DEPOSIT_PAYMENT_CONFIRMED`, `DEPOSIT_COMPLETED`, `DEPOSIT_CANCELLED`, `DEPOSIT_EXPIRED`, `DEPOSIT_REFUNDED` vào `ActivityEventType`, rồi dùng chúng trong `depositService.auditEntry`.

### 9.5 `src/services/carService.js` – `updateCarStatus` (khuyến nghị)
Nhân viên vẫn có thể đổi tay RESERVED → AVAILABLE/SOLD. Module đã xử lý an toàn trường hợp này bằng đối soát và cờ `reviewRequired`. Nếu muốn chặt hơn, chặn RESERVED → AVAILABLE khi xe đang có Deposit `holdActive`, và khi chuyển SOLD thì gọi `depositService.completeDeposit`.

### 9.6 `src/services/publicCarService.js` (tùy chọn)
`getPublicCarDetail` chỉ trả xe AVAILABLE, nên trang chi tiết xe báo 404 khi xe RESERVED. FE đã có trang `/xe/:carKey/dat-coc` để hiển thị thay. Nếu muốn trang chi tiết gốc vẫn mở được xe RESERVED, đổi filter thành `status: { $in: [AVAILABLE, RESERVED] }`.
