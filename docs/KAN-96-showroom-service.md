# KAN-96 — ShowroomService CRUD + Appointment Type SERVICE

**Sprint:** 20/11 → 12/12/2026
**Assignee:** Nguyễn Hữu Tú
**Priority:** Medium
**Due:** 07/12/2026
**Blocked by:** không (độc lập với KAN-93/94/95)

---

## 1. Mục tiêu

Thêm luồng **đặt lịch dịch vụ** vào hệ thống:

- Showroom có 6 gói dịch vụ chuẩn (rửa cao cấp, đánh bóng, phủ nano, bọc gầm, detailing nội thất, kiểm tra tổng quát) với giá tham khảo. Admin CRUD được qua trang quản trị.
- Trang công khai `/dich-vu` liệt kê 6 gói kèm CTA "Đặt lịch dịch vụ".
- Khách đã đăng nhập đặt được lịch dịch vụ ở 4 khung giờ cố định (giống test-drive) — cùng cơ chế holds, slot capacity, visit model.
- Lịch SERVICE không bắt buộc gắn với xe showroom: khách nhập biển số xe của họ để nhân viên nhận diện.
- Admin xem/duyệt lịch SERVICE chung bảng appointment như TEST_DRIVE.

---

## 2. Phân tích hiện trạng

- `src/models/showroom-service.model.js` có sẵn với 5 field: `serviceName`, `description`, `estimatedDuration` (phút), `referencePrice` (VND), `status` (ACTIVE/INACTIVE). Chưa có controller/route/seed.
- `src/constants/appConstants.js` `AppointmentType` hiện có `TEST_DRIVE`, `VIEWING`, `MAINTENANCE`. **Chưa có `SERVICE`.** `src/models/extendedEnums.js` có 1 enum `AppointmentType` khác (VIEW_CAR/TEST_DRIVE/SERVICE/VALUATION) nhưng **không ai dùng trong Appointment** — chỉ seed cho ERD. Giữ nguyên, không đụng.
- `Appointment.car` đang `required`. Phải cho optional khi `type === SERVICE`.
- Luồng booking (`appointmentBookingService.js`, `appointmentHolds.js`, capacity) viết riêng cho test-drive dùng `AppointmentType.TEST_DRIVE`. Không chạm luồng đó; mở route SERVICE song song dùng chung helper `appointmentSlotRules.js` / `appointmentWrite.js` / `withTransaction.js`.
- 4 slot cố định `SLOTS = ['08:00','10:00','13:00','15:00']` và capacity trong `baseSettings.testDrive.maxGuestsPerSlot` dùng chung — service share capacity với test-drive là chủ ý (cùng showroom, cùng không gian tiếp đón).

---

## 3. Thay đổi Constants

### `src/constants/appConstants.js`

**`AppointmentType`:** thêm `SERVICE`.
```js
export const AppointmentType = Object.freeze({
  TEST_DRIVE:  'TEST_DRIVE',
  VIEWING:     'VIEWING',
  MAINTENANCE: 'MAINTENANCE',
  SERVICE:     'SERVICE',          // ← KAN-96
});
```

**`Permissions`:** thêm permission mảng dịch vụ (CRUD gói service, không liên quan appointment).
```js
// ── Showroom Service (KAN-96) ──
SERVICE_READ:   'service:read',
SERVICE_WRITE:  'service:write',   // create/update/deactivate gói dịch vụ
```

**`ROLE_PERMISSIONS`:**
```js
[Roles.ADMIN]:       Object.values(Permissions),  // auto-include 2 permission mới
[Roles.SALES_STAFF]: [
  // ...existing...
  Permissions.SERVICE_READ,       // sale cần đọc danh sách gói khi tư vấn
],
// INSPECTOR, CUSTOMER: không có service permission (CRUD gói chỉ admin)
```

> Đọc danh sách gói công khai (`GET /public/services`) **không** cần permission — unauth.

---

## 4. Thay đổi Model

### 4.1 `src/models/showroom-service.model.js`

Model đã có đủ field cốt lõi. Bổ sung:

```js
const ShowroomServiceSchema = new Schema(
  {
    // Mã gói slug-style, phục vụ seed idempotent + URL chia sẻ sau này.
    code: {
      type: String, required: true, trim: true, uppercase: true,
      match: /^[A-Z0-9_]{3,40}$/,
    },
    serviceName:      { type: String, required: true, trim: true, maxlength: 120 },
    description:      { type: String, default: null, maxlength: 2000 },
    estimatedDuration:{ type: Number, required: true, min: 15, max: 480 }, // phút
    referencePrice:   { type: Number, required: true, min: 0 },            // VND
    status: {
      type: String, enum: Object.values(RecordStatus), default: RecordStatus.ACTIVE, index: true,
    },

    // Audit (giống các model khác trong repo).
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { collection: 'showroom_services', timestamps: true },
);

ShowroomServiceSchema.index({ code: 1 }, { unique: true, name: 'uniq_service_code' });
ShowroomServiceSchema.index({ status: 1, serviceName: 1 });
```

**Lý do:** `code` giữ giá trị ổn định (không đổi khi admin sửa tên hiển thị) → `Appointment.serviceSnapshot` chụp được một mã rõ ràng; seed idempotent bằng `updateOne({ code }, …, { upsert: true })`.

### 4.2 `src/models/Appointment.js`

Hai thay đổi:

1. **`car` optional khi type là SERVICE.**
   ```js
   car: {
     type:     Schema.Types.ObjectId,
     ref:      'Car',
     required: function () { return this.type !== AppointmentType.SERVICE; },
     index:    true,
   },
   ```
2. **Thêm block SERVICE:**
   ```js
   // ── Service appointment (KAN-96) ─────────────────────────────────
   service: {
     type:    Schema.Types.ObjectId,
     ref:     'ShowroomService',
     default: null,
     // required khi type === SERVICE, kiểm tra trong service layer để lỗi gom về AppError
   },
   // Snapshot name + price tại thời điểm đặt — không đổi khi admin sửa gói sau đó.
   serviceSnapshot: {
     type: new Schema({
       code:            { type: String, trim: true },
       serviceName:     { type: String, trim: true },
       referencePrice:  { type: Number, min: 0 },
       estimatedMinutes:{ type: Number, min: 0 },
     }, { _id: false }),
     default: undefined,
   },
   // Biển số xe KHÁCH mang tới (viết hoa, strip khoảng trắng) — chỉ dùng cho SERVICE
   serviceVehiclePlate: {
     type: String, trim: true, uppercase: true, maxlength: 15, default: null,
   },
   ```

**Index guard ngăn double-book khung giờ service của 1 khách:**
```js
AppointmentSchema.index(
  { customer: 1, scheduledAt: 1 },
  {
    name: 'uniq_service_open_per_customer_slot',
    unique: true,
    partialFilterExpression: {
      type: AppointmentType.SERVICE,
      status: { $in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
      isActive: true,
    },
  },
);
```

> `uniq_seat_car_time` (test-drive) có `partialFilterExpression: { slotSeat: { $type: 'number' } }`. Lịch SERVICE **không set `slotSeat`** → không chạm index đó, test-drive không bị ảnh hưởng.

---

## 5. Seed 6 gói dịch vụ

### `src/seeders/showroomServiceSeeder.js` (mới)

```js
import ShowroomService from '../models/showroom-service.model.js';
import { RecordStatus } from '../models/extendedEnums.js';

const SEED = [
  { code: 'CAR_WASH_PREMIUM', serviceName: 'Rửa xe cao cấp',
    description: 'Rửa ngoài, hút nội thất, dưỡng taplo, lau kính sạch sâu.',
    estimatedDuration: 60,  referencePrice:   200_000 },
  { code: 'POLISH',           serviceName: 'Đánh bóng sơn',
    description: 'Xóa xước mờ, phục hồi độ bóng, đánh 2 bước bằng máy chuyên dụng.',
    estimatedDuration: 180, referencePrice:   800_000 },
  { code: 'CERAMIC_COATING',  serviceName: 'Phủ nano ceramic',
    description: 'Phủ ceramic 9H, bảo vệ sơn 12 tháng, chống xước nhẹ.',
    estimatedDuration: 240, referencePrice: 3_000_000 },
  { code: 'UNDERBODY_COATING',serviceName: 'Bọc gầm cách âm',
    description: 'Phủ vật liệu cao su chống rỉ, cách âm gầm toàn xe.',
    estimatedDuration: 180, referencePrice: 1_500_000 },
  { code: 'INTERIOR_DETAIL',  serviceName: 'Detailing nội thất',
    description: 'Vệ sinh ghế da, trần, thảm, dưỡng nhựa, khử mùi ozone.',
    estimatedDuration: 180, referencePrice: 1_000_000 },
  { code: 'GENERAL_INSPECTION', serviceName: 'Kiểm tra tổng quát',
    description: 'Check 60 hạng mục: động cơ, phanh, lốp, ắc-quy, điều hoà — xuất báo cáo PDF.',
    estimatedDuration: 90,  referencePrice:   300_000 },
];

/**
 * Idempotent: upsert theo `code`. Admin chỉnh `serviceName`/`referencePrice`
 * qua UI thì **không** bị seed ghi đè — chỉ tạo mới gói còn thiếu.
 */
export const seedShowroomServices = async () => {
  for (const spec of SEED) {
    const existed = await ShowroomService.findOne({ code: spec.code }).lean();
    if (existed) continue;
    await ShowroomService.create({ ...spec, status: RecordStatus.ACTIVE });
  }
};

export default { seedShowroomServices };
```

Gọi trong `server.js` step 4 (sau `seedAdminAccount()`):

```js
await seedShowroomServices();   // KAN-96
```

---

## 6. API

### 6.1 Public — `GET /api/v1/public/services`

Mount trong `publicSettingsRoutes.js` hoặc tạo `publicServiceRoutes.js` mount vào `/public`.

**Query:** không có. Trả về **chỉ các gói ACTIVE**, sort theo `serviceName`.

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "6554…",
      "code": "CAR_WASH_PREMIUM",
      "serviceName": "Rửa xe cao cấp",
      "description": "Rửa ngoài, hút nội thất…",
      "estimatedDuration": 60,
      "referencePrice": 200000
    }
  ]
}
```

Response dùng mapper riêng **không trả** `status`, `createdBy`, `updatedBy`, `createdAt` (không cần cho công khai).

### 6.2 Manage — `/api/v1/manage/services`

Route mới `src/routes/serviceRoutes.js`, mount vào `/manage/services`. Toàn bộ require `verifyToken`.

| Method | Path | Permission | Mô tả |
|---|---|---|---|
| GET    | `/manage/services`         | `service:read`  | list cả ACTIVE + INACTIVE, filter `?status`, `?search`, phân trang |
| GET    | `/manage/services/:id`     | `service:read`  | chi tiết |
| POST   | `/manage/services`         | `service:write` | tạo gói mới, `code` unique |
| PUT    | `/manage/services/:id`     | `service:write` | cập nhật mọi field trừ `code` |
| DELETE | `/manage/services/:id`     | `service:write` | **soft-delete**: set `status = INACTIVE`, không xoá hẳn |

**Lý do soft-delete:** `Appointment.service` giữ ObjectId; nếu xoá cứng gói đã có lịch sẽ mất ref. INACTIVE chặn tạo mới (service-layer check) nhưng vẫn populate được cho lịch cũ.

### 6.3 Customer — `GET /api/v1/customer/appointments/service-slots`

Dùng khi khách chọn khung giờ đặt lịch SERVICE. Khác slot test-drive ở chỗ **không lọc theo carId** (lịch SERVICE không gắn xe showroom). Chia sẻ 4 slot `SLOTS` + `getSlotCapacity()`.

**Query:**
- `from`, `to`: `YYYY-MM-DD` (giờ VN), max 14 ngày — dùng `parseDateKey` sẵn.

**Logic:**
```js
const openServiceRows = await Appointment.find({
  type: AppointmentType.SERVICE,
  status: { $in: OPEN_STATUSES },
  isActive: true,
  scheduledAt: { $gte: from, $lt: toExclusive },
}).select('scheduledAt customer').lean();

// Mỗi slot: capacity = getSlotCapacity() (dùng chung với test-drive)
// unavailable khi:
//   - slot < now + 2h  → TOO_SOON
//   - slot > now + 60d → TOO_FAR
//   - đã có lịch SERVICE của chính khách này ở slot đó → ALREADY_BOOKED
//   - đếm open rows SERVICE của mọi khách ≥ capacity → CAPACITY_FULL
```

**Chú ý capacity dùng chung:** một slot có capacity N thì tổng `TEST_DRIVE visits + SERVICE appointments` tại slot đó ≤ N. Đếm chung từ cả hai loại rows → đoạn tính `taken` cần gộp:

```js
const taken = testDriveVisitsAtSlot(slot) + serviceRowsAtSlot(slot);
```

Để tránh viết lại toàn bộ `appointmentSlotService.js`, bổ sung helper nhỏ `countServiceAtSlot(slotDate)` và inject vào `loadSlots`:

```js
// appointmentSlotService.js (sửa nhẹ):
const serviceCount = await Appointment.countDocuments({
  type: AppointmentType.SERVICE, status: { $in: OPEN_STATUSES }, isActive: true,
  scheduledAt: { $gte: from, $lt: toExclusive },
}).then(groupByExactSlot /* nhóm theo scheduledAt */);
// … ở chỗ tính capacityTaken: taken = testDriveTaken + (serviceCount.get(slot) || 0)
```

### 6.4 Customer — `POST /api/v1/customer/appointments/service`

Tạo lịch SERVICE. Route mới trong `customerAppointmentRoutes.js`, controller mới `createServiceAppointment`.

**Body:**
```json
{
  "serviceId": "6554…",            // required
  "scheduledAt": "2026-12-01T08:00:00+07:00",   // required, khớp 1 slot cố định
  "serviceVehiclePlate": "51K-123.45",          // required, trim+upper
  "notes": "Xe dính nhựa đường, cần tẩy kỹ"     // optional, max 500
}
```

**Thuật toán** (transaction, dùng `withTransaction` + `runWithRetry`):
1. Thời gian: `assertBookableTime(scheduledAt, now)` (REQ-19 giống test-drive — ≥ 2h, ≤ 60d, trúng slot).
2. Load `service` theo `serviceId`, phải `status === ACTIVE`, nếu không → `AppError 400 SERVICE_UNAVAILABLE`.
3. Lock khách: `Customer.updateOne({ _id: customerId }, { $set: { updatedAt: new Date() } }, { session })` (giống test-drive).
4. Đếm trong slot:
   - `openServiceAtSlot = countServiceAtSlot(scheduledAt)` qua session.
   - `openTdAtSlot = testDriveVisitsAtSlot(scheduledAt)` qua `findOpenAtSlot(scheduledAt).then(groupIntoVisits)`.
   - Nếu `openServiceAtSlot + openTdAtSlot ≥ capacity` → `AppError 409 SLOT_FULL`.
5. Check khách đã có lịch SERVICE ở slot đó chưa → unique index đã guard; nếu insert trả duplicate key 11000 với `uniq_service_open_per_customer_slot` → `AppError 409 ALREADY_BOOKED_SERVICE`.
6. Tạo code: `allocateCodes(1)` → `APT-NNNN`.
7. Insert Appointment:
   ```js
   {
     appointmentCode, customer, car: null, type: SERVICE,
     scheduledAt, durationMinutes: 90, location: SHOWROOM_LOCATION,
     status: PENDING,
     service: service._id,
     serviceSnapshot: {
       code: service.code, serviceName: service.serviceName,
       referencePrice: service.referencePrice,
       estimatedMinutes: service.estimatedDuration,
     },
     serviceVehiclePlate,
     notes: notes || null,
     createdBy: userId,
   }
   ```
8. Log audit `logAppointmentEvents` với `summary: 'Service appointment created'`.
9. Trả về DTO (mục 8).

**Không** gắn `slotSeat`/`holdsCar`/`visitSeat` — SERVICE không chiếm chỗ xe cũng không chiếm "seat số" (duy nhất ràng buộc: tổng ≤ capacity, kiểm qua count).

### 6.5 Customer — `GET /api/v1/customer/appointments/service` + `PATCH /:id/cancel`

- List lịch SERVICE của chính khách: tận dụng `listMine` hiện tại nhưng cho query `?type=SERVICE` được parse.
- Huỷ: dùng lại `cancelMyVisit` nhưng SERVICE không phải "visit đa xe" → route riêng `PATCH /customer/appointments/service/:id/cancel` gọi handler nhỏ:
  ```js
  // Chỉ chủ lịch + status PENDING/CONFIRMED + slot >= now + 2h (hoặc cho huỷ muộn, flag isLate)
  ```

### 6.6 Staff — lịch SERVICE ở bảng appointment chung

`GET /api/v1/appointments` có sẵn filter `?status`, thêm filter `?type=SERVICE` (đã có field `type` sẵn trong `staffListQuery` không? Kiểm tra `appointmentSchemas.js`; nếu chưa thì thêm `type: Joi.string().valid(...Object.values(AppointmentType))`).

`PATCH /appointments/:id/status` dùng chung — tuy nhiên `canTransition` của visit model hiện áp cho mọi row. Lịch SERVICE là 1 row độc lập (không gộp visit), nên `deriveVisitStatus([row])` trả thẳng `row.status` → transition rule chạy đúng.

---

## 7. Joi Schemas

### `src/routes/serviceSchemas.js` (mới)

```js
import Joi from 'joi';
import { RecordStatus } from '../models/extendedEnums.js';

const name = Joi.string().trim().min(3).max(120);
const price = Joi.number().integer().min(0).max(500_000_000);
const duration = Joi.number().integer().min(15).max(480);
const code = Joi.string().trim().uppercase().pattern(/^[A-Z0-9_]{3,40}$/);

export const createServiceSchema = Joi.object({
  code: code.required(),
  serviceName: name.required(),
  description: Joi.string().trim().max(2000).allow('', null),
  estimatedDuration: duration.required(),
  referencePrice: price.required(),
  status: Joi.string().valid(...Object.values(RecordStatus)).default(RecordStatus.ACTIVE),
});

export const updateServiceSchema = Joi.object({
  serviceName: name,
  description: Joi.string().trim().max(2000).allow('', null),
  estimatedDuration: duration,
  referencePrice: price,
  status: Joi.string().valid(...Object.values(RecordStatus)),
}).min(1);

export const listServicesQuery = Joi.object({
  status: Joi.string().valid(...Object.values(RecordStatus)),
  search: Joi.string().trim().max(120),
  page:   Joi.number().integer().min(1).default(1),
  limit:  Joi.number().integer().min(1).max(50).default(20),
});
```

### Trong `appointmentSchemas.js` — bổ sung

```js
export const createServiceAppointmentSchema = Joi.object({
  serviceId:           Joi.string().hex().length(24).required(),
  scheduledAt:         Joi.string().isoDate().required(), // service layer parse + check slot
  serviceVehiclePlate: Joi.string().trim().uppercase().min(5).max(15).required(),
  notes:               Joi.string().trim().max(500).allow('', null),
});
```

---

## 8. DTO trả về khách

```js
// toCustomerServiceAppointment(row, service)
{
  id: row._id,
  appointmentCode: row.appointmentCode,
  type: 'SERVICE',
  status: row.status,
  scheduledAt: formatVnIso(row.scheduledAt),      // '2026-12-01T08:00:00+07:00'
  durationMinutes: row.durationMinutes,
  location: row.location,
  service: {
    id: service?._id ?? row.service,
    code: row.serviceSnapshot?.code,
    serviceName: row.serviceSnapshot?.serviceName,
    referencePrice: row.serviceSnapshot?.referencePrice,
    estimatedMinutes: row.serviceSnapshot?.estimatedMinutes,
  },
  vehiclePlate: row.serviceVehiclePlate,
  notes: row.notes,
  createdAt: row.createdAt?.toISOString(),
  cancellation: row.status === 'CANCELLED' ? {
    reason: row.cancellationReason, at: row.updatedAt?.toISOString()
  } : null,
}
```

Allow-list — không spread document (tuân nguyên tắc REQ-024 của test-drive mapper).

---

## 9. Frontend

### 9.1 Trang công khai `/dich-vu`

- Route mới trong `src/router/AppRouter.jsx`: `<Route path="/dich-vu" element={<ServicesPage />} />`.
- Component `src/features/services/pages/ServicesPage.jsx` fetch `GET /public/services`, render grid 6 card.
- Mỗi card: tên + mô tả + "Thời lượng ~X phút" + giá tham khảo định dạng `vi-VN`. CTA "Đặt lịch dịch vụ":
  - Khách chưa đăng nhập → redirect `/dang-nhap?redirect=/dich-vu/dat/{serviceId}`.
  - Đã đăng nhập → đi tới wizard đặt lịch (9.2).
- Thêm link "Dịch vụ" vào `Footer.jsx` cột "Dịch vụ" + navbar nếu có.

### 9.2 Wizard đặt lịch service `/dich-vu/dat/:serviceId`

3 bước nhẹ (tái dùng look-and-feel wizard test-drive):

1. **Xác nhận gói** — hiển thị thông tin service đọc từ `/public/services`.
2. **Chọn khung giờ** — gọi `GET /customer/appointments/service-slots?from=…&to=…`. Dùng chung component `SlotPicker` của test-drive nhưng ẩn dropdown chọn xe.
3. **Nhập biển số + ghi chú → Xác nhận** → `POST /customer/appointments/service`. Thành công → điều hướng `/lich-hen?tab=service`.

### 9.3 Trang quản trị `/admin/dich-vu`

- Thêm route trong AppRouter admin: `<Route path="dich-vu" element={<AdminServicesPage />} />`.
- Bảng danh sách: cột `code`, `serviceName`, `estimatedDuration`, `referencePrice` (format tiền), `status`, action Sửa/Vô hiệu.
- Form tạo/sửa dùng Ant Design `Form` (hoặc stack hiện tại, đồng bộ với `AdminBaseSettingsPage`).
- `DELETE` hỏi xác nhận: "Vô hiệu gói này? Lịch cũ vẫn giữ nguyên, khách sẽ không thấy gói trên /dich-vu."

### 9.4 `/lich-hen` — tab Service

Màn `CustomerAppointmentsPage` hiện tại chỉ list test-drive. Thêm tab `SERVICE`:
- Fetch `GET /customer/appointments?type=SERVICE`.
- Mỗi row: badge "Dịch vụ", tên gói từ snapshot, khung giờ, biển số xe, nút Huỷ (nếu PENDING/CONFIRMED và còn > 2h).

### 9.5 Admin > Lịch hẹn

Bảng hiện tại add filter chọn Type: `TEST_DRIVE / SERVICE / Tất cả`. Khi SERVICE: cột "Xe" hiển thị biển số khách nhập, link tới service detail thay cho ảnh xe.

---

## 10. Test Plan

### Backend

| # | File test | Loại | Setup | Expected |
|---|---|---|---|---|
| T1 | `service-seeder.test.js` | unit | Chạy `seedShowroomServices` khi DB trống | 6 gói được tạo, tất cả `ACTIVE`, `code` khớp danh sách |
| T2 | `service-seeder.test.js` | unit | Seed 2 lần; admin sửa `referencePrice` gói thứ 2 giữa 2 lần seed | Gói 2 giữ giá đã sửa, không bị reset |
| T3 | `service-crud-routes.test.js` | integ | ADMIN `POST /manage/services` body hợp lệ | `201`, trả về gói với `_id`, `status=ACTIVE` |
| T4 | | integ | ADMIN `POST` với `code` trùng | `409 DUPLICATE_SERVICE_CODE` |
| T5 | | integ | SALES_STAFF `POST` | `403 PERMISSION_DENIED` |
| T6 | | integ | SALES_STAFF `GET /manage/services` | `200` (có `service:read`) |
| T7 | | integ | ADMIN `PUT /manage/services/:id` đổi `serviceName`+`referencePrice` | `200`, document trả về đã cập nhật |
| T8 | | integ | ADMIN `DELETE /manage/services/:id` | `200`, record `status = INACTIVE`, document vẫn còn trong DB |
| T9 | `public-services.test.js` | integ | Unauth `GET /public/services` sau khi seed | `200`, trả 6 gói, không có field `status` |
| T10 | | integ | Admin set 1 gói `INACTIVE` → `GET /public/services` | Gói đó không xuất hiện |
| T11 | `service-appointment-booking.test.js` | integ | Khách `POST /customer/appointments/service` body hợp lệ, slot còn chỗ | `201`, Appointment có `type=SERVICE`, `car=null`, `serviceSnapshot` đầy đủ |
| T12 | | integ | Khách `POST` với `serviceId` đã INACTIVE | `400 SERVICE_UNAVAILABLE` |
| T13 | | integ | Khách đã có 1 lịch SERVICE ở slot X, `POST` thêm lịch SERVICE cùng slot X (dù khác gói) | `409 ALREADY_BOOKED_SERVICE` (unique index catch) |
| T14 | | integ | Capacity = 3, slot X đã có 2 TEST_DRIVE visits + 1 SERVICE của khách khác, khách mới `POST` lịch SERVICE slot X | `409 SLOT_FULL` |
| T15 | | integ | `scheduledAt` = now + 1h30 | `400 SLOT_TOO_SOON` (reuse `assertBookableTime`) |
| T16 | | integ | `scheduledAt` không trúng `08:00/10:00/13:00/15:00` | `400 SLOT_NOT_ALLOWED` |
| T17 | | integ | STAFF `GET /appointments?type=SERVICE` sau khi tạo 2 service + 1 TD | 2 rows SERVICE, đúng cả `serviceSnapshot` |
| T18 | | integ | Khách `PATCH /customer/appointments/service/:id/cancel` còn 24h trước | `200`, status `CANCELLED` |
| T19 | | integ | ADMIN sửa `referencePrice` gói đã có lịch | Lịch cũ: `serviceSnapshot.referencePrice` **không đổi** (snapshot stable) |
| T20 | `service-slot-counts.test.js` | unit | Hàm `countServiceAtSlot` với 3 rows cùng slot, 1 row CANCELLED | Trả về 2 |

### Frontend

| # | Loại | Mô tả |
|---|---|---|
| F1 | component | `ServicesPage` render 6 card đúng tên+giá khi API trả 6 gói |
| F2 | component | CTA "Đặt lịch" khi unauth → điều hướng login với redirect query |
| F3 | hook | `useServiceBooking` xử lý 3 bước, bước 3 submit đúng payload |
| F4 | component | `AdminServicesPage` lọc theo `status`, soft-delete trả về INACTIVE row ẩn ở `/public/services` nhưng vẫn hiển thị ở admin |

> Lưu ý harness BE: đăng ký mock cho `ShowroomService` từ `tests/helpers/fakeServiceModels.js` theo pattern `fakeAppointmentModels.js` (jest.unstable_mockModule đường dẫn `src/models/showroom-service.model.js` phải khai báo từ file trong `tests/helpers/`, không khai từ file test — xem [[backend-test-harness-quirks]]).

---

## 11. Thứ tự triển khai

1. `appConstants.js` — thêm `AppointmentType.SERVICE`, 2 permission `SERVICE_READ/WRITE`, map `ROLE_PERMISSIONS`.
2. `showroom-service.model.js` — thêm `code`, `createdBy/updatedBy`, index unique `code`.
3. `Appointment.js` — `car` conditional required, thêm `service / serviceSnapshot / serviceVehiclePlate`, index SERVICE guard.
4. Seeder + gọi trong `server.js`. Khởi động local, verify 6 gói.
5. CRUD service: controller + repository + route + Joi schemas + test T3–T8.
6. Public endpoint + test T9–T10.
7. Booking service appointment: controller + service layer + slot counts + test T11–T16, T18–T20.
8. Mở rộng staff list filter `?type` + test T17.
9. FE: trang `/dich-vu` + wizard đặt lịch + admin CRUD + tab service trong `/lich-hen`.
10. Smoke test end-to-end: seed → public list → đặt lịch → admin xác nhận → huỷ.

---

## 12. Rủi ro & lưu ý

- **Capacity dùng chung TD + SERVICE** là lựa chọn chủ ý. Nếu thực tế showroom phàn nàn (ví dụ: 1 slot rửa xe + 3 test-drive hoạt động song song không vấn đề), tách capacity riêng bằng setting mới `baseSettings.service.maxSlotCapacity`. Giữ hook tính `taken` trong `appointmentSlotService.js` ở một chỗ để đổi dễ.
- **`code` immutable** sau khi tạo. Nếu admin đổi `code`, snapshot cũ không tra ngược về gói được — không nên cho sửa qua API.
- **Soft-delete gói** không khôi phục qua UI riêng; set lại `status = ACTIVE` qua PUT là đủ.
- **Lịch SERVICE không chiếm `holdsCar`** nên không xung đột khi showroom bán xe (đó cũng là lý do `car = null`).


