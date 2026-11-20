# KAN-94 — Role INSPECTOR phụ + Assignment UI

**Sprint:** 20/11 → 12/12/2026  
**Assignee:** Nguyễn Hữu Tú  
**Priority:** High  
**Due:** 03/12/2026  
**Blocked by:** KAN-93 (User.roles array phải xong trước)

---

## 1. Mục tiêu

Thêm role `INSPECTOR` vào hệ thống để:

- Tách biệt quyền **làm biên bản kiểm định CPO** khỏi quyền bán hàng (SALES_STAFF).
- Một nhân viên bán hàng vẫn có thể kiêm inspector bằng cách mang cả 2 role (`SALES_STAFF` + `INSPECTOR`) — nhờ multi-role từ KAN-93.
- Admin có UI gán/bỏ role INSPECTOR cho từng staff user.
- Toàn bộ inspection routes chuyển sang kiểm tra permission `inspection:write` / `inspection:read` thay vì hard-code `restrictTo(SALES_STAFF, ADMIN)`.

---

## 2. Phân tích hiện trạng

Inspection routes hiện dùng:

```js
const INSPECTION_WRITERS = [Roles.SALES_STAFF, Roles.ADMIN];
const INSPECTION_READERS = [Roles.SALES_STAFF, Roles.ADMIN];
restrictTo(...INSPECTION_WRITERS)  // = authorizeRoles(...)
```

`restrictTo` chỉ so sánh `roleName` đơn → sau KAN-93 phải chuyển sang `requirePermission('inspection:write')` để hưởng lợi từ union permission.

---

## 3. Thay đổi Constants

### `src/constants/appConstants.js`

**Thêm vào `Roles`:**
```js
export const Roles = Object.freeze({
  ADMIN:       'ADMIN',
  SALES_STAFF: 'SALES_STAFF',
  CUSTOMER:    'CUSTOMER',
  INSPECTOR:   'INSPECTOR',   // <-- thêm
});
```

**Thêm vào `Permissions`:**
```js
// ── Inspection ──
INSPECTION_READ:   'inspection:read',
INSPECTION_WRITE:  'inspection:write',   // tạo draft, cập nhật, submit
INSPECTION_ADMIN:  'inspection:admin',   // reject, approve-sale (ADMIN only)
```

**Thêm vào `ROLE_PERMISSIONS`:**
```js
[Roles.INSPECTOR]: [
  Permissions.INSPECTION_READ,
  Permissions.INSPECTION_WRITE,
  Permissions.CAR_READ,          // cần để xem thông tin xe khi lập biên bản
],

// Update SALES_STAFF — thêm inspection permissions
[Roles.SALES_STAFF]: [
  // ...existing permissions...
  Permissions.INSPECTION_READ,
  Permissions.INSPECTION_WRITE,
],

// Update ADMIN — thêm inspection:admin
[Roles.ADMIN]: Object.values(Permissions),  // already includes all, no change needed
```

**Thêm `INSPECTOR` vào `StaffRoles`:**
```js
export const StaffRoles = Object.freeze([Roles.ADMIN, Roles.SALES_STAFF, Roles.INSPECTOR]);
```

---

## 4. Seed Role INSPECTOR

`Role.seedDefaultRoles()` trong `server.js` đã chạy idempotent — chỉ cần thêm description vào seed map:

```js
// Role.js → seedDefaultRoles()
const descriptions = {
  [Roles.ADMIN]:       'Full system access.',
  [Roles.SALES_STAFF]: 'Operational access — inventory, customers, leads, appointments.',
  [Roles.CUSTOMER]:    'Self-registered website customer.',
  [Roles.INSPECTOR]:   'Vehicle inspector — CPO checklist only; no sales access.',  // thêm
};
```

Khởi động server lần đầu sau deploy sẽ tự seed role này.

---

## 5. Thay đổi Inspection Routes

### `src/routes/inspectionRoutes.js`

Thay toàn bộ `restrictTo(...)` bằng `requirePermission(...)`:

```js
import { requirePermission } from '../middlewares/roleMiddleware.js';
import { Permissions } from '../constants/appConstants.js';

// Trước:
// const INSPECTION_WRITERS = [Roles.SALES_STAFF, Roles.ADMIN];
// restrictTo(...INSPECTION_WRITERS)

// Sau:
const canWrite = requirePermission(Permissions.INSPECTION_WRITE);
const canRead  = requirePermission(Permissions.INSPECTION_READ);
const canAdmin = requirePermission(Permissions.INSPECTION_ADMIN);

router.post('/cars/:id/draft',            canWrite, byId, inspectionController.createDraft);
router.post('/cars/:id/inspect',          canWrite, byId, validate(quickInspectSchema), inspectionController.inspectCar);
router.post('/cars/:id/upload-signature', canWrite, byId, inspectionController.createCarUploadSignature);
router.put( '/cars/:id/approve-sale',     canAdmin, byId, inspectionController.approveSale);
router.get( '/:id',                       canRead,  byId, inspectionController.getInspection);
router.patch('/:id',                      canWrite, byId, validate(updateDraftSchema), inspectionController.updateDraft);
router.post('/:id/upload-signature',      canWrite, byId, inspectionController.createUploadSignature);
router.post('/:id/submit',                canWrite, byId, inspectionController.submitInspection);
router.put( '/:id/reject',                canAdmin, byId, validate(rejectInspectionSchema), inspectionController.rejectInspection);
```

> **Lưu ý:** `inspection:admin` chỉ ADMIN có (xem ROLE_PERMISSIONS) → `approve-sale` và `reject` vẫn ADMIN-only về mặt thực tế, nhưng được kiểm tra qua permission chứ không hard-code role.

---

## 6. API: Lấy danh sách Inspector để gán cho xe

### `GET /api/v1/users?roles=INSPECTOR`

Filter user theo role. Dùng khi Admin muốn gán inspector cho một lượt kiểm định.

**Query params:** `roles` (optional, comma-separated) — filter theo bất kỳ role nào trong `roleNames[]`.

**Thêm vào `userController.list` / `userRepository`:**

```js
// userRepository.js — buildQuery
if (query.roles) {
  const roleList = query.roles.split(',').map(r => r.trim().toUpperCase());
  filter.roleNames = { $in: roleList };
}
```

---

## 7. Frontend — Assignment UI

### 7.1 Admin > Users > Edit Staff — checkbox INSPECTOR

Dùng lại component checkbox roles đã build ở KAN-93. Sau khi thêm `INSPECTOR` vào `Roles` enum và seed DB, `GET /api/roles` trả về role này tự động → checkbox xuất hiện mà không cần thay đổi FE thêm.

### 7.2 Admin > Inspections — cột "Inspector"

Trên bảng danh sách InspectionRecord, cột Inspector hiển thị tên + badge role:

```
Nguyễn Văn A   [INSPECTOR] [SALES_STAFF]
```

Lấy từ `inspectorId` đã populate.

### 7.3 Tạo Draft — chọn Inspector

Khi ADMIN tạo draft thay mặt một inspector:

```
Assign Inspector *
[ Dropdown: search staff có role INSPECTOR ]
```

FE gọi `GET /api/v1/users?roles=INSPECTOR&isActive=true` để populate dropdown.

---

## 8. Test Plan

| # | Loại | Setup | Expected |
|---|---|---|---|
| T1 | unit | Seed — INSPECTOR chưa có trong DB | `seedDefaultRoles` tạo mới, không throw |
| T2 | unit | Seed 2 lần | idempotent |
| T3 | integ | User `roleNames: ['INSPECTOR']` → `POST /inspections/cars/:id/draft` | `201` |
| T4 | integ | User `roleNames: ['INSPECTOR']` → `PUT /inspections/:id/reject` | `403` (thiếu `inspection:admin`) |
| T5 | integ | User `roleNames: ['INSPECTOR']` → `PUT /cars/:id/approve-sale` | `403` |
| T6 | integ | User `roleNames: ['ADMIN']` → `PUT /inspections/:id/reject` | `200` |
| T7 | integ | User `roleNames: ['SALES_STAFF']` → `POST /inspections/cars/:id/draft` | `201` (vẫn có `inspection:write`) |
| T8 | integ | User `roleNames: ['SALES_STAFF', 'INSPECTOR']` → `POST /draft` | `201` (union) |
| T9 | integ | User `roleNames: ['CUSTOMER']` → `GET /inspections/:id` | `403` |
| T10 | integ | `GET /api/v1/users?roles=INSPECTOR` | trả về chỉ users có INSPECTOR trong `roleNames` |

---

## 9. Thứ tự triển khai

1. **`appConstants.js`** — thêm `INSPECTOR` vào `Roles`, `StaffRoles`, `Permissions` (3 permission mới), `ROLE_PERMISSIONS`.
2. **`Role.js`** — thêm description INSPECTOR vào `seedDefaultRoles`.
3. **Deploy / restart server** — INSPECTOR role được seed tự động.
4. **`roleMiddleware.js`** — đảm bảo `requirePermission` đọc `req.userPermissions` (đã làm ở KAN-93 bước 5).
5. **`inspectionRoutes.js`** — thay `restrictTo` bằng `requirePermission` như mục 5.
6. **`userRepository.js`** — thêm filter `roles` query param.
7. **FE** — dropdown inspector dùng `GET /api/v1/users?roles=INSPECTOR`; badge INSPECTOR trên bảng inspection.
8. Viết + chạy test T1–T10.

> Sau bước 1–3, Admin đã có thể gán role INSPECTOR cho bất kỳ staff user nào qua UI từ KAN-93.
