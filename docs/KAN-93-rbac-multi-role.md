# KAN-93 — RBAC Đa Role: `User.roles` Array + Migration + UI

**Sprint:** 20/11 → 12/12/2026  
**Assignee:** Nguyễn Hữu Tú  
**Priority:** Highest  
**Due:** 01/12/2026  
**Blocks:** KAN-94 (Role INSPECTOR phụ)

---

## 1. Mục tiêu

Hệ thống hiện tại cho phép mỗi User đúng **một** role (field `role: ObjectId` + `roleName: String`). KAN-93 nâng cấp lên **mảng role** để:

- Một nhân viên có thể mang đồng thời nhiều role (ví dụ: SALES_STAFF + INSPECTOR sau khi KAN-94 xong).
- Tập permission của user là **hợp (union)** permission của tất cả role được gán.
- Middleware RBAC (`requirePermission`, `requireRole`) hoạt động không đổi với caller ngoài — chỉ nội bộ thay đổi cách tính permission.
- Admin có UI gán/bỏ nhiều role cho một staff user.

---

## 2. Phân tích hiện trạng

| File | Điểm liên quan |
|---|---|
| `src/models/User.js` | `role: ObjectId ref Role` (single), `roleName: String` (denorm) |
| `src/models/Role.js` | `name` enum `Roles`, `permissions: [String]` |
| `src/constants/appConstants.js` | `Roles`, `Permissions`, `ROLE_PERMISSIONS`, `StaffRoles` |
| `src/middlewares/authMiddleware.js` | Attach `req.user`, `req.userRole = user.roleName`, populate `role` |
| `src/middlewares/roleMiddleware.js` | `requirePermission` đọc `ROLE_PERMISSIONS[userRole]`; `requireRole` so `user.roleName` |

Vấn đề: `requirePermission` chỉ tra `ROLE_PERMISSIONS[req.user.roleName]` — đây là lookup tĩnh theo **một** role. Sau migration phải tra union của nhiều role.

---

## 3. Thiết kế Schema

### 3.1 User Schema — thay đổi

```js
// THÊM (mới)
roles: {
  type:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'Role' }],
  default: [],
},
roleNames: {
  type:    [String],
  enum:    Object.values(Roles),
  default: [],
  // Denormalized array — mirror của roles[], dùng cho JWT + fast middleware
},

// GIỮ NGUYÊN (backward compat, sẽ sync từ roles[0])
role:     { type: mongoose.Schema.Types.ObjectId, ref: 'Role' },
roleName: { type: String, enum: Object.values(Roles) },
```

**Quy ước:**
- `roles[0]` / `roleNames[0]` = "primary role" — dùng để hiển thị trên UI và điền ngược `role`/`roleName`.
- Legacy code đọc `role`/`roleName` vẫn hoạt động vì hai field đó được giữ, nhưng **chỉ write qua `roles[]`**.

### 3.2 Index mới

```js
UserSchema.index({ roleNames: 1 }); // filter staff by any role
```

---

## 4. Migration

### 4.1 Script: `scripts/migrate-user-roles.js`

Chạy **một lần** trên DB production/dev trước khi deploy code mới:

```js
// Pseudo-code — triển khai ở mục 7
// Với mỗi User có role != null và roles == []:
//   set roles = [user.role], roleNames = [user.roleName]
// Với User đã có roles[] (re-run safe): skip
```

Idempotent: kiểm tra `user.roles.length > 0` trước khi update.

### 4.2 Rollback

Nếu cần rollback: `role` và `roleName` không bị xóa → old code hoạt động ngay.

---

## 5. Thay đổi Logic

### 5.1 `authMiddleware.js` — `authenticate()`

```js
// Thay dòng populate('role') thành:
const user = await User.findById(decoded.userId)
  .select('+tokenVersion +password')
  .populate('roles')   // <-- array
  .lean();

// Tính union permissions:
const allPermissions = Array.from(
  new Set((user.roles || []).flatMap(r => r.permissions || []))
);

req.user            = user;
req.userId          = user._id.toString();
req.userRole        = user.roleNames?.[0] ?? user.roleName; // primary
req.userRoles       = user.roleNames ?? [user.roleName];    // all
req.userPermissions = allPermissions;                       // union
```

### 5.2 `roleMiddleware.js` — `requirePermission`

```js
export const requirePermission = (...permissions) => (req, _res, next) => {
  // Dùng req.userPermissions nếu có (new path), fallback sang ROLE_PERMISSIONS (compat)
  const userPerms = req.userPermissions
    ?? (ROLE_PERMISSIONS[req.user?.roleName] || []);

  const ok = permissions.some(p => userPerms.includes(p));
  if (!ok) return next(new AppError(...));
  next();
};
```

`requireRole` vẫn so với `req.userRoles`:

```js
export const requireRole = (...roles) => (req, _res, next) => {
  const userRoles = req.userRoles ?? [req.user?.roleName];
  if (!roles.some(r => userRoles.includes(r)))
    return next(new AppError(...));
  next();
};
```

### 5.3 JWT Payload

Thêm `roleNames` array vào payload:

```js
// utils/authTokens.js — khi issue access token
{
  userId:    user._id,
  roleNames: user.roleNames,     // <-- thêm
  roleName:  user.roleNames[0],  // backward compat
  tv:        user.tokenVersion,
  type:      'access',
}
```

---

## 6. API Changes

### 6.1 `GET /api/users/:id` — response thêm `roles[]`

```json
{
  "_id": "...",
  "fullName": "Nguyễn Văn A",
  "roleNames": ["SALES_STAFF", "INSPECTOR"],
  "roleName":  "SALES_STAFF",
  "roles": [
    { "_id": "...", "name": "SALES_STAFF", "permissions": [...] },
    { "_id": "...", "name": "INSPECTOR",   "permissions": [...] }
  ]
}
```

### 6.2 `PUT /api/users/:id/roles` — endpoint mới

Chỉ ADMIN được gọi.

**Request:**
```json
{ "roleIds": ["<ObjectId SALES_STAFF>", "<ObjectId INSPECTOR>"] }
```

**Validation:**
- `roleIds` phải là mảng non-empty ObjectId.
- Mỗi id phải tồn tại trong `roles` collection và `isActive: true`.
- Không được gán role CUSTOMER cho staff (và ngược lại).
- Phải giữ ít nhất 1 role.

**Response `200`:**
```json
{ "message": "Roles updated.", "roleNames": ["SALES_STAFF", "INSPECTOR"] }
```

**Errors:**
- `400 VALIDATION_ERROR` — roleIds rỗng / không hợp lệ.
- `403 FORBIDDEN` — caller không phải ADMIN.
- `404 NOT_FOUND` — user không tồn tại.
- `409 CONFLICT` — cố gán CUSTOMER vào staff account.

### 6.3 Không thay đổi các route hiện có

`POST /api/users` (create staff) vẫn nhận `roleId: ObjectId` đơn — service sẽ tự map vào `roles: [roleId]`.

---

## 7. Migration Script

`scripts/migrate-user-roles.js`

```js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import User from '../src/models/User.js';

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected. Starting migration…');

  const cursor = User.find({ roles: { $size: 0 }, role: { $ne: null } })
    .select('role roleName roles roleNames')
    .cursor();

  let count = 0;
  for await (const user of cursor) {
    if (user.roles && user.roles.length > 0) continue;
    await User.updateOne(
      { _id: user._id },
      { $set: { roles: [user.role], roleNames: user.roleName ? [user.roleName] : [] } }
    );
    count++;
  }

  console.log(`Migration done. Updated ${count} user(s).`);
  await mongoose.disconnect();
}

run().catch(err => { console.error(err); process.exit(1); });
```

Chạy: `node -r dotenv/config scripts/migrate-user-roles.js`

---

## 8. Service: `updateUserRoles`

Thêm vào `src/services/userService.js`:

```js
export async function updateUserRoles(userId, roleIds) {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found.', 404, 'NOT_FOUND');
  if (!roleIds || roleIds.length === 0)
    throw new AppError('At least one role is required.', 400, 'VALIDATION_ERROR');

  const roles = await Role.find({ _id: { $in: roleIds }, isActive: true });
  if (roles.length !== roleIds.length)
    throw new AppError('One or more role IDs are invalid.', 400, 'VALIDATION_ERROR');

  const roleNames = roles.map(r => r.name);
  const hasCustomer = roleNames.includes('CUSTOMER');
  const hasStaff    = roleNames.some(n => n !== 'CUSTOMER');
  if (hasCustomer && hasStaff)
    throw new AppError('Cannot mix CUSTOMER with staff roles.', 409, 'CONFLICT');
  if (hasCustomer && user.roleName !== 'CUSTOMER')
    throw new AppError('Cannot assign CUSTOMER role to a staff account.', 409, 'CONFLICT');

  user.roles     = roles.map(r => r._id);
  user.roleNames = roleNames;
  user.role      = roles[0]._id;   // primary — backward compat
  user.roleName  = roleNames[0];
  await user.save();
  return user;
}
```

---

## 9. Frontend (Admin UI)

### 9.1 Edit Staff page — thêm section "Roles"

```
Roles *
┌─────────────────────────────────┐
│ ☑ SALES_STAFF  (primary)        │
│ ☐ INSPECTOR                     │
│ ☐ ADMIN                         │
└─────────────────────────────────┘
[Save Roles]
```

- Checkbox list từ `GET /api/roles` (active roles, không gồm CUSTOMER).
- Role đầu tiên được check = primary (tự động, không cần user chọn thứ tự).
- Phải chọn ít nhất 1.
- Submit → `PUT /api/users/:id/roles`.

### 9.2 Danh sách user — cột Role

Hiển thị tất cả badge: `[SALES_STAFF] [INSPECTOR]`

---

## 10. Test Plan

| # | Loại | Setup | Expected |
|---|---|---|---|
| T1 | unit | `updateUserRoles(id, [salesId])` | `roleNames=['SALES_STAFF']`, `roleName='SALES_STAFF'` |
| T2 | unit | `roleIds = []` | throws `400 VALIDATION_ERROR` |
| T3 | unit | roleId không tồn tại | throws `400 VALIDATION_ERROR` |
| T4 | unit | mix CUSTOMER + SALES_STAFF | throws `409 CONFLICT` |
| T5 | unit | CUSTOMER vào staff account | throws `409 CONFLICT` |
| T6 | integ | user `roleNames: ['SALES_STAFF','INSPECTOR']` | `req.userPermissions` = union cả 2 role |
| T7 | integ | user `roleNames: ['INSPECTOR']`, call `car:create` route | `403 FORBIDDEN` |
| T8 | integ | user `roleNames: ['ADMIN','SALES_STAFF']` | có full permissions |
| T9 | migrate | user cũ `role=X, roles=[]` | sau migrate: `roles=[X], roleNames=[X.name]` |
| T10 | migrate | chạy script 2 lần | idempotent, không tạo duplicate |

---

## 11. Thứ tự triển khai

1. `appConstants.js` — thêm `INSPECTOR` vào `Roles` với `permissions: []` (sẽ điền ở KAN-94).
2. `User.js` — thêm `roles[]`, `roleNames[]`, index `{ roleNames: 1 }`.
3. Chạy `scripts/migrate-user-roles.js` trên dev DB.
4. `authMiddleware.js` — populate `roles`, tính `req.userPermissions` = union.
5. `roleMiddleware.js` — `requirePermission` đọc `req.userPermissions`; `requireRole` kiểm tra `req.userRoles`.
6. `authTokens.js` — thêm `roleNames` vào JWT payload.
7. `userService.js` — thêm `updateUserRoles`.
8. Route `PUT /api/users/:id/roles` + validation schema.
9. Update list/get user response để trả `roles[]` + `roleNames[]`.
10. FE: checkbox roles trên Admin Edit Staff, badge trên danh sách.
11. Viết + chạy test T1–T10.

> **KAN-94 unblocked** sau bước 1 — có thể tạo role INSPECTOR song song.

