# KAN-98 — Vehicle History Report PDF + QR Verify

**Sprint:** 20/11 → 12/12/2026
**Assignee:** Nguyễn Hữu Tú
**Priority:** Medium
**Due:** 10/12/2026
**Blocked by:** không (tái dùng hạ tầng CPO certificate của KAN-15/KAN-20)

---

## 1. Mục tiêu

Mở rộng "chứng nhận CPO 1 trang" thành **báo cáo lịch sử xe 3 trang**:

1. **Trang 1** — nhận diện xe + kết quả 5 nhóm tiêu chí (giữ nguyên nội dung chứng nhận hiện tại).
2. **Trang 2** — lịch sử vận hành: ngày nhập kho, số chủ cũ, lịch sử ODO, lịch sử giá, các lần bảo dưỡng/sửa.
3. **Trang 3** — lịch sử kiểm định, khuyết điểm nhỏ, phạm vi báo cáo, QR verify + chữ ký số hoá.

- PDF tải công khai tại `GET /api/v1/public/history/:code/pdf`.
- QR trên PDF trỏ tới `{FRONTEND_URL}/verify/{hash}`; trang đó gọi `GET /api/v1/public/verify/:hash` để hiển thị bản tóm tắt.
- Hash **thay đổi khi xe được cấp chứng nhận mới** (kiểm định lại) → QR cũ tự vô hiệu, chống dùng lại ảnh chụp báo cáo cũ.

**DoD:** xuất PDF 2–3 trang cho xe VF8 đã CPO; quét QR mở đúng trang verify của chính xe đó; sửa hash trong URL → 404.

---

## 2. Phân tích hiện trạng

Đã có, tái dùng được:

| Thành phần | Vị trí | Ghi chú |
|---|---|---|
| PDF writer tự viết, không phụ thuộc thư viện | `src/utils/miniPdf.js` | Helvetica + WinAnsi; **chỉ 1 trang** (`/Count 1`, `/Kids [3 0 R]`) |
| QR encoder tự viết (ISO/IEC 18004) | `src/utils/qrMatrix.js` | `makeQrMatrix(text, { ecc })` → `{ size, modules }` |
| CPO certificate PDF 1 trang | `src/services/cpoCertificatePdf.js` | Mẫu layout, palette, `formatDate`, `drawQr`, `formatNumber` |
| Public report mapper | `src/services/inspectionReportMapper.js` | allow-list field, `toInitials`, `ReportLevel` |
| Public report service | `src/services/inspectionReportService.js` | chọn record chứng nhận theo `cpoCertificateId` |
| Route PDF hiện tại | `publicCarRoutes.js` → `/:id/cpo-certificate.pdf` | đặt **trước** `/:id` |
| `PriceHistory` (embedded) | `Car.priceHistory[]` | `oldPrice/newPrice/dropAmount/reason/createdAt/changedBy` |
| `InspectionRecord.odo` + `submittedAt` | | mỗi biên bản SUBMITTED là một mốc ODO thật |
| `ActivityLog` CAR_STATUS_CHANGED | | nguồn "các lần bảo dưỡng" (vào/ra MAINTENANCE) |

Ba khoảng trống phải xử lý:

1. **`miniPdf` không hỗ trợ nhiều trang.** Phải mở rộng (mục 6) và giữ nguyên hành vi trang đơn cho certificate cũ.
2. **Không có field "số chủ cũ" / ngày đăng ký / lịch sử sửa chữa.** Phải thêm vào `Car` (mục 3) và form nhập xe.
3. **Không có hash verify.** Phải sinh + lưu trên `Car` để tra ngược từ QR (mục 4).

> Ticket ghi "Dùng pdf skill để render chuẩn": kỹ năng `pdf`/`pdf-reading` dùng ở **bước phát triển** để soi layout PDF thật và chỉnh toạ độ; runtime của app vẫn là `miniPdf` thuần JS vì sandbox không cài được thư viện mới (xem [[no-npm-install-in-sandbox]]).

---

## 3. Thay đổi Model — `src/models/Car.js`

Thêm 4 field phục vụ báo cáo (không phá dữ liệu cũ, tất cả có default):

```js
    // ── Vehicle History Report (KAN-98) ───────────────────────────────
    /** Số chủ sở hữu trước khi TrustCar nhập xe. Nhân viên nhập lúc intake. */
    previousOwnersCount: { type: Number, default: 0, min: 0, max: 20 },
    /** Ngày đăng ký lần đầu (trên giấy tờ), nhập tay. Null khi chưa rõ. */
    registrationDate: { type: Date, default: null },
    /**
     * Các lần sửa/bảo dưỡng do nhân viên ghi tay lúc intake (lịch sử chủ cũ khai).
     * Không trùng với các lần xe vào trạng thái MAINTENANCE — phần đó suy từ ActivityLog.
     */
    serviceHistory: {
      type: [new mongoose.Schema({
        performedAt:  { type: Date, required: true },
        odometer:     { type: Number, min: 0, default: null },
        description:  { type: String, trim: true, maxlength: 300, required: true },
        provider:     { type: String, trim: true, maxlength: 120, default: null },
      }, { _id: true })],
      default: [],
    },
    /**
     * Hash tra ngược từ QR verify. Sinh từ (carId, cpoCertificateId, secret) — xem
     * services/vehicleHistoryService.js. Sparse unique: xe chưa CPO không có field này.
     */
    historyVerifyHash: { type: String, trim: true, default: null },
```

Index:

```js
CarSchema.index(
  { historyVerifyHash: 1 },
  { unique: true, sparse: true, name: 'uniq_history_verify_hash' },
);
```

**Ai ghi `historyVerifyHash`:** `applyVerdictToCar()` trong `src/services/inspectionShared.js` — đây là **nơi duy nhất** đặt `cpoCertificateId`, nên cũng là nơi duy nhất hash đổi theo. Thêm 1 dòng trước `car.save({ session })`:

```js
  car.cpoCertificateId = cpoCertificateId;
  car.historyVerifyHash = cpoCertificateId
    ? buildHistoryVerifyHash(car._id, cpoCertificateId)
    : null;
```

Xe bị REJECTED → hash null → QR cũ 404 ngay sau lần kiểm định lại. Không cần cron dọn.

**Backfill** cho xe đã có chứng nhận trước KAN-98: script `scripts/backfill-history-verify-hash.js` theo mẫu `src/seeders/cpoCertificateBackfill.js` (chạy tay 1 lần, idempotent: chỉ set khi `cpoCertificateId != null && historyVerifyHash == null`).

---

## 4. Hash verify — `src/services/vehicleHistoryService.js` (mới, phần thuần)

```js
import crypto from 'crypto';

const SECRET = () => process.env.VERIFY_HASH_SECRET || process.env.JWT_SECRET || 'trustcar-dev-verify';
export const HISTORY_HASH_LENGTH = 24;

/**
 * Hash ổn định, không đoán được, đổi khi cấp chứng nhận mới.
 * @param {string|ObjectId} carId
 * @param {string} certificateId  e.g. 'CPO-20261201-A1B2'
 * @returns {string} 24 hex chars
 */
export const buildHistoryVerifyHash = (carId, certificateId) =>
  crypto.createHash('sha256')
    .update(`${String(carId)}:${certificateId}:${SECRET()}`)
    .digest('hex')
    .slice(0, HISTORY_HASH_LENGTH);
```

- Không lưu secret vào DB; đổi secret = toàn bộ QR cũ chết (chấp nhận được, ghi trong mục 12).
- 24 hex = 96 bit → đủ chống dò, URL vẫn ngắn (`/verify/a3f9…`).
- Test phải mock/dọn `process.env.VERIFY_HASH_SECRET` để kết quả tất định.

---

## 5. Service tổng hợp báo cáo

### `src/services/vehicleHistoryReport.js` (mới, PURE — không DB)

Xây object báo cáo từ dữ liệu đã nạp sẵn; **allow-list từng field** giống `inspectionReportMapper` để không rò rỉ `floorPrice`, `vin`, `licensePlate`, `internalNotes`.

```js
/**
 * @param {object} p
 * @param {object} p.car            - lean Car (projection riêng, xem §7)
 * @param {object} p.certRecord     - InspectionRecord chứng nhận (đã qua buildPublicReport)
 * @param {object[]} p.inspectionRecords - mọi InspectionRecord SUBMITTED của xe, cũ → mới
 * @param {object[]} p.maintenanceSessions - ActivityLog CAR_STATUS_CHANGED → MAINTENANCE
 * @param {string} p.qrTarget       - URL verify tuyệt đối
 * @returns {object} VehicleHistoryReport
 */
export const buildVehicleHistoryReport = (...) => ({ ... });
```

**Cấu trúc trả về:**

```js
{
  verifyHash: 'a3f9…',
  verifyUrl: 'https://trustcar.vn/verify/a3f9…',
  generatedAt: '2026-12-08T…',
  certificate: { id: 'CPO-20261201-A1B2', issuedAt, inspectorInitials: 'N.V.A.', level: 'FULL' },
  vehicle: {
    vehicleCode, make, model, variant, color, year,
    currentMileage, fuelType, transmission,
    // KHÔNG có vin, licensePlate, floorPrice
  },
  ownership: {
    previousOwnersCount: 2,
    registrationDate: '2019-03-14',
    ownerType: 'INDIVIDUAL',
    intakeAt: '2026-10-02',          // car.createdAt
    daysInStock,                     // tính tại thời điểm xuất báo cáo
  },
  odometerHistory: [                 // sort tăng dần theo thời gian
    { at: '2026-06-10', value: 41200, source: 'INSPECTION' },
    { at: '2026-10-02', value: 44890, source: 'INTAKE' },     // car.mileage lúc tạo
    { at: '2026-12-01', value: 44950, source: 'INSPECTION' },
  ],
  priceHistory: [                    // từ car.priceHistory, mới → cũ
    { at, oldPrice, newPrice, dropAmount, reason },
  ],
  maintenance: [                     // gộp 2 nguồn, sort mới → cũ
    { at: '2026-10-14', kind: 'WORKSHOP', description: 'Vào bảo dưỡng trước bán' },   // ActivityLog
    { at: '2025-08-02', kind: 'DECLARED', description: 'Thay dầu, lọc gió', provider: 'Hãng', odometer: 38000 },
  ],
  inspections: [                     // mọi biên bản SUBMITTED của xe
    { at, result: 'PASSED'|'FAILED', certificateId, inspectorInitials },
  ],
  criteria: [ { key, label, passed } ],      // 5 nhóm của biên bản chứng nhận
  minorDefects: [ { label, location, description } ],
  scopeNote: '…',
}
```

**Quy tắc gộp ODO** — chỉ lấy mốc *thật*:

| Nguồn | Lấy khi |
|---|---|
| `INSPECTION` | record SUBMITTED có `odo > 0` |
| `INTAKE` | `car.mileage > 0` và `car.createdAt` — đại diện số km lúc nhập kho |

Khử trùng lặp theo `(ngày, giá trị)`; nếu chỉ có 1 mốc, mảng vẫn trả 1 phần tử và PDF ghi "Chưa đủ dữ liệu để đối chiếu ODO".

**Quy tắc gộp maintenance** — hai loại `kind`:
- `WORKSHOP`: dựng từ `ActivityLog` có `eventType = CAR_STATUS_CHANGED` và `changes.after.status = 'MAINTENANCE'` → "Vào xưởng bảo dưỡng trước bán".
- `DECLARED`: từ `car.serviceHistory[]` (chủ cũ khai, nhân viên nhập).

### `src/services/vehicleHistoryService.js` — phần DB

```js
export const getHistoryReport = async (idOrCode) => { … }
export const getVerifySummary = async (hash) => { … }
```

**`getHistoryReport(idOrCode)`**
1. `Car.findOne({ ...byIdOrCode, isActive: true, status: { $in: [APPROVED_CPO, AVAILABLE] }, cpoCertificateId: { $ne: null } }, HISTORY_CAR_PROJECTION).lean()` — trả `404 VEHICLE_HISTORY_NOT_FOUND` nếu không khớp (giống cách `inspectionReportService` gộp mọi trường hợp lỗi).
2. Nếu `historyVerifyHash` null (xe cũ trước KAN-98) → tính + `updateOne` set (lazy self-heal).
3. Nạp song song: `InspectionRecord.find({ carId, status: { $in: [SUBMITTED, null] } })` sort `submittedAt` asc; `ActivityLog.find({ targetModel: 'Car', targetId: car._id, eventType: CAR_STATUS_CHANGED })` rồi lọc trong JS `changes?.after?.status === 'MAINTENANCE'`; `User.find` cho tên inspector (chỉ để lấy initials).
4. Gọi `buildVehicleHistoryReport(...)`.

**Projection (allow-list, đúng những gì báo cáo cần):**
```js
const HISTORY_CAR_PROJECTION = {
  vehicleCode: 1, make: 1, model: 1, variant: 1, year: 1, fuelType: 1, transmission: 1,
  mileage: 1, 'specifications.color': 1,
  cpoCertificateId: 1, historyVerifyHash: 1, status: 1,
  previousOwnersCount: 1, registrationDate: 1, ownerType: 1, serviceHistory: 1,
  priceHistory: 1, createdAt: 1, listedDate: 1, daysInStock: 1,
};
```
Tuyệt đối **không** đưa `vin`, `licensePlate`, `floorPrice`, `internalNotes`, `originalPrice`, `costPrice`.

> **Đừng tái dùng `PUBLIC_DETAIL_PROJECTION` của `publicCarService.js`.** Đó là allow-list *hẹp hơn* nhu cầu: nó ẩn `priceHistory`, `daysInStock`, `listedDate` (`PUBLIC_HIDDEN_FIELDS`). Báo cáo lịch sử **cố ý** công bố một phần các dữ liệu đó (số ngày trong kho, các mốc giảm giá) theo yêu cầu ticket, nên dùng projection riêng ở trên — vừa đủ, vẫn chặn giá sàn và VIN. Đây là quyết định chính sách có chủ đích, ghi rõ trong PR.

**`getVerifySummary(hash)`** — dùng cho trang `/verify/:hash`:
1. Validate `^[0-9a-f]{24}$` → sai định dạng trả 404 luôn (không chạm DB).
2. `Car.findOne({ historyVerifyHash: hash, isActive: true }, VERIFY_PROJECTION).lean()`; `null` → `404 VERIFY_NOT_FOUND`.
3. Trả tóm tắt (không trả toàn bộ lịch sử):
```js
{
  verified: true,
  vehicle: { vehicleCode, title: 'VinFast VF 8 Plus', year, color, currentMileage },
  certificate: { id, issuedAt, result: 'PASSED' },
  score: { previousOwnersCount, inspectionsCount, priceChangesCount, maintenanceCount },
  pdfUrl: '/api/v1/public/history/TC-2026-0042/pdf',
  generatedAt,
}
```
4. Xe chuyển `DELISTED`/`SOLD` sau khi bán → vẫn verify được? **Có**, nhưng thêm `status: 'SOLD'` vào response để trang ghi "Xe đã bán — báo cáo giữ nguyên giá trị lịch sử". Chỉ loại `isActive: false`.

---

## 6. Mở rộng `miniPdf` cho nhiều trang

`createPdf` hiện dựng đúng 1 page trong `toBuffer()` — thứ tự object là `catalog(1), pages(2), page(3), content(4), font(5), font(6)` và cuối hàm **assert** đúng thứ tự đó. Nếu đổi thứ tự để hỗ trợ N trang thì certificate CPO đang chạy sẽ đổi byte và test `cpo-certificate-pdf.test.js` có thể vỡ.

**Nguyên tắc:** giữ **nguyên văn nhánh 1 trang**; chỉ rẽ sang nhánh mới khi có gọi `newPage()`.

```js
export const createPdf = ({ width = 595.28, height = 841.89 } = {}) => {
  let commands = [];
  const finishedPages = [];          // các trang đã đóng bằng newPage()

  const api = {
    width, height,

    /** Đóng trang hiện tại, mở trang mới. Trang đơn không cần gọi. */
    newPage() {
      finishedPages.push(commands.join('\n'));
      commands = [];
    },

    // …rect / strokeRect / line / text giữ nguyên y hệt…

    toBuffer() {
      // Nhánh cũ: chưa ai gọi newPage → chạy đúng code hiện tại, byte-identical.
      if (finishedPages.length === 0) return buildSinglePage(commands.join('\n'));

      // Nhánh nhiều trang: dựng font TRƯỚC để biết ID, rồi mới dựng page objects.
      const contents = [...finishedPages, commands.join('\n')];
      const objects = [];
      const add = (body) => { objects.push(body); return objects.length; };

      const catalogId = add(null);                       // điền sau
      const pagesId   = add(null);                       // điền sau
      const fontId    = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      const fontBoldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

      const pageIds = contents.map((content) => {
        const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
        return add([
          '<< /Type /Page',
          `/Parent ${pagesId} 0 R`,
          `/MediaBox [0 0 ${num(width)} ${num(height)}]`,
          `/Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontBoldId} 0 R >> >>`,
          `/Contents ${contentId} 0 R >>`,
        ].join(' '));
      });

      objects[pagesId - 1]   = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
      objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;

      return assemble(objects);      // header + objects + xref + trailer, tách từ code cũ
    },
  };
  return api;
};
```

Tách phần "header + objects + xref + trailer" thành `assemble(objects)` để cả hai nhánh dùng chung — nhưng nhánh 1 trang phải sinh **cùng dãy object, cùng thứ tự** như code hiện tại để giữ byte-identical.

Test `tests/mini-pdf-pages.test.js` khoá:
- 1 trang (không `newPage`) → buffer **giống hệt** bản trước KAN-98 (fixture hex/bytes).
- 3 trang → `/Count 3`, `/Kids` đúng 3 ID, 3 content stream khác rỗng.
- `/F1` `/F2` trỏ đúng ID font ở cả hai nhánh.
- `startxref` trỏ đúng vị trí `xref` (đọc bằng skill `pdf-reading` sau khi implement).

---

## 7. API

### 7.1 `GET /api/v1/public/history/:code/pdf`

Đặt trong `publicCarRoutes.js`, **trước** `router.get('/:id'…)` (giống `/:id/cpo-certificate.pdf` — thực ra path khác gốc `/history/...` nên không bị `/:id` bắt, nhưng giữ quy ước đặt trước cho dễ đọc).

**Param:** `:code` = `vehicleCode` (TC-YYYY-NNNN) **hoặc** ObjectId — dùng đúng helper `byIdOrCode` hiện có.

**Middleware:** public, không auth. Thêm `createHistoryPdfLimiter` (30 req / 10 phút / IP) vì render PDF tốn CPU.

**Controller:**
```js
export const getVehicleHistoryPdf = async (req, res, next) => {
  try {
    const report = await vehicleHistoryService.getHistoryReport(req.params.code);
    const pdf = renderVehicleHistoryPdf(report);          // services/vehicleHistoryPdf.js
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition',
      `inline; filename="lich-su-${report.vehicle.vehicleCode || 'xe'}.pdf"`);
    return res.status(200).send(pdf);
  } catch (error) { return next(error); }
};
```

| Tình huống | Status | code |
|---|---|---|
| Không có xe / chưa CPO / bị DELISTED | 404 | `VEHICLE_HISTORY_NOT_FOUND` |
| Quá rate limit | 429 | `HISTORY_PDF_RATE_LIMIT` |

### 7.2 `GET /api/v1/public/verify/:hash`

Controller trả JSON tóm tắt (§5). 404 `VERIFY_NOT_FOUND` cho hash sai, hash của xe đã đổi chứng nhận, và hash sai định dạng — **cùng một lỗi**, không phân biệt.

---

## 8. PDF layout — `src/services/vehicleHistoryPdf.js` (mới)

Dùng lại palette + helper của `cpoCertificatePdf.js` (export `NAVY/GOLD/...` hoặc copy hằng số; **không** import vòng).

**Trang 1 — Nhận diện & chứng nhận** (giữ gần y nguyên certificate hiện tại)
- Header band navy + "LICH SU XE / VEHICLE HISTORY REPORT".
- Khối xe: hãng/model/đời/màu/km/fuel.
- Bảng 5 nhóm tiêu chí ✅/❌.
- Góc phải dưới: **QR verify** + "Quet ma de xac thuc tren trustcar.vn".

**Trang 2 — Lịch sử vận hành**
- Bảng "Thông tin sở hữu": ngày nhập kho, số chủ cũ, ngày đăng ký lần đầu, loại chủ (CTY/CN), số ngày trong kho.
- Bảng "Lịch sử ODO": `Ngày | Số km | Nguồn` + dòng `+x km` giữa hai mốc liên tiếp. Nếu <2 mốc → "Chưa đủ dữ liệu để đối chiếu".
- Bảng "Lịch sử giá": `Ngày | Giá cũ | Giá mới | Giảm`, tối đa 12 dòng gần nhất; ghi chú nếu cắt bớt.
- Danh sách "Bảo dưỡng / sửa chữa": `Ngày — Mô tả (đơn vị)`. Nếu rỗng → "Chưa ghi nhận".

**Trang 3 — Kiểm định & xác thực**
- Bảng "Lịch sử kiểm định": `Ngày | Kết quả | Mã chứng nhận | Người kiểm định (viết tắt)`.
- Khuyết điểm nhỏ của biên bản chứng nhận gần nhất.
- `scopeNote` (PUBLIC_REPORT_SCOPE_NOTE).
- Khối xác thực: `Ma xac thuc: {verifyHash}` + URL verify in dạng chữ + **QR lặp lại** (để trang 3 tự đứng độc lập khi in rời).
- Footer: "Tài liệu phát hành tự động — giá trị xác thực nằm ở bản gốc trên hệ thống TrustCar."

**Quy ước chữ:** `miniPdf` dùng WinAnsi, không có dấu tiếng Việt → viết **không dấu** như certificate hiện tại (`CHUNG NHAN KIEM DINH`). Giữ nhất quán, không nửa có dấu nửa không.

**Phân trang an toàn:** dựng hàm `ensureSpace(pdf, y, needed)` — nếu `y - needed < 70` thì `pdf.newPage()` và trả `PAGE_H - MARGIN - 40` (chừa header nhỏ). Không dựa vào "chắc là vừa 3 trang": xe 20 lần đổi giá sẽ tràn.

---

## 9. Frontend

### 9.1 Trang `/verify/:hash` (công khai)

- `AppRouter`: `<Route path="/verify/:hash" element={<Suspense…><VerifyPage /></Suspense>} />` — **ngoài** `PrivateRoute`.
- `features/vehicle-history/api/vehicleHistoryApi.js`:
  ```js
  export async function fetchVerifySummary(hash, signal) {
    const { data } = await api.get(`/public/verify/${encodeURIComponent(hash)}`, { signal })
    return data?.data
  }
  ```
- `features/vehicle-history/pages/VerifyPage.jsx`: gọi API theo `hash`; 3 trạng thái:
  - **verified**: banner xanh "Chứng nhận hợp lệ", card xe + chứng nhận + 4 số đếm, nút "Tải báo cáo PDF" (link `pdfUrl`).
  - **404**: banner đỏ "Không tìm thấy chứng nhận này. Mã có thể đã cũ hoặc không hợp lệ." + link về `/xe`.
  - **xe đã bán**: banner vàng "Xe đã được bán — báo cáo giữ nguyên giá trị lịch sử tại thời điểm cấp."
- Không hiển thị gì khác ngoài summary (không lộ lịch sử giá chi tiết trên web; PDF là nơi xem đầy đủ).

### 9.2 Nút tải báo cáo

- `CarDetailPage`: cạnh khối CPO hiện có, thêm `Button` "Báo cáo lịch sử xe (PDF)" — chỉ render khi `car.cpoCertificateId` tồn tại; `href` là `${API_BASE_URL}/public/history/${encodeURIComponent(car.vehicleCode)}/pdf`, `target="_blank"`.
- Trang `CpoCertificateDetailPage` (admin) thêm cùng nút.

### 9.3 Form nhập xe — `VehicleDetailsForm.jsx`

Thêm 3 trường vào bước thông tin xe:
- `previousOwnersCount` — `InputNumber` 0–20.
- `registrationDate` — `DatePicker`, không bắt buộc.
- `serviceHistory` — danh sách động (thêm/xoá dòng) với `performedAt`, `odometer`, `description`, `provider`; tối đa 20 dòng.

Backend: cho phép 3 field này trong schema tạo/cập nhật xe (`carSchemas` / DTO), kèm validate:
```js
previousOwnersCount: Joi.number().integer().min(0).max(20),
registrationDate:    Joi.date().iso().max('now').allow(null),
serviceHistory:      Joi.array().items(Joi.object({
  performedAt: Joi.date().iso().max('now').required(),
  odometer:    Joi.number().integer().min(0).allow(null),
  description: Joi.string().trim().min(3).max(300).required(),
  provider:    Joi.string().trim().max(120).allow('', null),
})).max(20),
```

---

## 10. Test Plan

### BE — thuần (không DB)

`tests/vehicle-history-report.test.js`

| # | Setup | Expected |
|---|---|---|
| T1 | car đủ dữ liệu, 3 inspection records, 2 price changes, 1 serviceHistory + 1 MAINTENANCE log | object đúng cấu trúc §5; `maintenance` có 2 phần tử đúng thứ tự mới→cũ |
| T2 | JSON.stringify(report) | **không** chứa `vin`, `licensePlate`, `floorPrice`, `internalNotes`, `costPrice` |
| T3 | ODO: 2 inspection + car.mileage | 3 mốc, sort tăng dần, không trùng |
| T4 | ODO: chỉ car.mileage | 1 mốc + cờ `insufficientData: true` |
| T5 | priceHistory 20 phần tử | `priceHistory` cắt còn 12, có `truncated: true` |
| T6 | maintenance từ ActivityLog nhưng `changes.after.status = AVAILABLE` | không bị tính |
| T7 | inspector không tìm thấy user | `inspectorInitials: null`, không throw |

`tests/vehicle-history-hash.test.js`

| # | Setup | Expected |
|---|---|---|
| T8 | cùng (carId, cert, secret) | hash 24 hex, tất định |
| T9 | đổi `certificateId` | hash khác |
| T10 | đổi secret | hash khác |
| T11 | cert `null` | `buildHistoryVerifyHash` không được gọi (hash = null ở tầng gọi) |

### BE — endpoint

`tests/vehicle-history-endpoint.test.js`

| # | Setup | Expected |
|---|---|---|
| T12 | xe APPROVED_CPO có hash | `GET /public/history/TC-2026-0042/pdf` → 200, `Content-Type: application/pdf`, body bắt đầu `%PDF-1.4` |
| T13 | xe `DELISTED` | 404 `VEHICLE_HISTORY_NOT_FOUND` |
| T14 | xe chưa có `cpoCertificateId` | 404 |
| T15 | xe chưa có `historyVerifyHash` (dữ liệu cũ) | 200 + DB được set hash (self-heal) |
| T16 | `GET /public/verify/:hash` đúng | 200, `verified: true`, `pdfUrl` đúng |
| T17 | hash 23 ký tự / chữ hoa / không hex | 404, **không** chạm DB (assert spy) |
| T18 | hash đúng nhưng xe `isActive: false` | 404 |
| T19 | xe `SOLD` | 200 + `status: 'SOLD'` |
| T20 | 31 request PDF / 10 phút | request 31 → 429 |
| T21 | kiểm định lại → `historyVerifyHash` đổi | hash cũ 404, hash mới 200 (test `applyVerdictToCar`) |

`tests/mini-pdf-pages.test.js`

| # | Setup | Expected |
|---|---|---|
| T22 | `createPdf()` 1 trang, không gọi `newPage` | bytes giống hệt fixture trước KAN-98 |
| T23 | 3 trang | `/Count 3`, `/Kids` 3 ID, 3 stream, `startxref` trỏ đúng |

`tests/vehicle-history-pdf.test.js`

| # | Setup | Expected |
|---|---|---|
| T24 | report đầy đủ | `%PDF-1.4` … `%%EOF`; `/Count 3` |
| T25 | report nghèo dữ liệu (0 service, 1 ODO) | vẫn hợp lệ, `/Count 2` hoặc 3 (không vỡ) |
| T26 | 20 dòng priceHistory + 12 inspection | không tràn — tổng số trang ≥ 3 nhưng **mỗi** `/Page` có content stream khác rỗng |
| T27 | QR: đọc lại text trong PDF | chứa `verifyHash` + URL `/verify/` |

### FE

| # | Loại | Mô tả |
|---|---|---|
| F1 | unit | `fetchVerifySummary` gọi đúng URL, encode hash |
| F2 | component | `VerifyPage` 3 trạng thái verified / 404 / SOLD |
| F3 | component | `CarDetailPage` chỉ hiện nút PDF khi có `cpoCertificateId` |

> Khi implement: dùng skill `pdf-reading` để mở PDF sinh ra, soi layout thật (đúng tinh thần "Dùng pdf skill để render chuẩn" của ticket) thay vì chỉ assert header bytes.

---

## 11. Thứ tự triển khai

1. `miniPdf`: `newPage()` + `toBuffer()` nhiều trang, sửa tham chiếu font động; test T22–T23 **trước** để khoá không hồi quy.
2. `Car` model: 4 field + sparse unique index; DTO/schema tạo–cập nhật xe; form intake FE.
3. `vehicleHistoryService.js` (hash + `getHistoryReport` + `getVerifySummary`); `applyVerdictToCar` set hash; backfill script.
4. `vehicleHistoryReport.js` (pure builder) + test T1–T11.
5. `vehicleHistoryPdf.js` + `ensureSpace` + template 3 trang; test T24–T27.
6. Routes `/public/history/:code/pdf` + `/public/verify/:hash` + limiter; test T12–T21.
7. FE `VerifyPage` + route + nút tải PDF; test F1–F3.
8. Smoke: xe VF8 seed → kiểm định → xuất PDF → quét QR bằng điện thoại → trang verify đúng; sửa 1 ký tự hash → 404.

---

## 12. Rủi ro & lưu ý

- **`miniPdf` là code dùng chung với certificate đang chạy production.** Mọi thay đổi phải giữ test T22 xanh (byte-identical cho trang đơn). Nếu không giữ được byte-identical, phải chấp nhận và ghi rõ trong PR — nhưng tuyệt đối không để certificate hiện tại vỡ.
- **Hash đổi khi đổi `VERIFY_HASH_SECRET`**: toàn bộ QR đã in sẽ chết. Nếu cần xoay secret, giữ secret cũ để verify song song (thêm `VERIFY_HASH_SECRET_PREVIOUS`, thử lần lượt) — chưa làm ở pha này, ghi để biết.
- **Số chủ cũ là dữ liệu khai báo**, không kiểm chứng được. Trang verify và PDF phải ghi rõ nguồn ("theo khai báo của chủ xe") — tránh quảng cáo sai sự thật.
- **`priceHistory` nội bộ**: lịch sử giảm giá từng bước có thể để lộ chiến lược định giá. Ticket yêu cầu in, nhưng chỉ in **số tuyệt đối + % giảm**, không in `floorPrice`/`originalPrice` — projection đã chặn.
- **ActivityLog MAINTENANCE không có index `changes.after.status`**: truy vấn lọc trong JS sau khi lấy theo `targetId + eventType` (đã có index riêng). Nếu về sau chậm, thêm index compound — chưa cần ở quy mô đồ án.
- **Ảnh chụp màn hình PDF vẫn làm giả được**: QR là lớp xác thực duy nhất; hash đổi khi kiểm định lại nên ảnh cũ tự mất giá trị. Ghi rõ trong `scopeNote` để không overclaim.
- **Trang `/verify/:hash` là public**: chỉ trả summary; không trả VIN, biển số, giá niêm yết nội bộ, hay toàn bộ lịch sử giá.
