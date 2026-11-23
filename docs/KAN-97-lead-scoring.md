# KAN-97 — Lead Scoring Engine từ InteractionEvent

**Sprint:** 20/11 → 12/12/2026
**Assignee:** Nguyễn Hữu Tú
**Priority:** Medium
**Due:** 08/12/2026
**Blocked by:** không (InteractionEvent + VisitorSession + Lead đã có)

---

## 1. Mục tiêu

Biến hành vi duyệt web thành tín hiệu bán hàng:

- Ghi nhận tương tác ẩn danh/đã đăng nhập qua `POST /api/v1/track` (public, rate-limited).
- Cron 5 phút chấm lại **Lead.score** (0–100) từ `InteractionEvent`, có decay theo thời gian.
- Chia band **HOT (>70) / WARM (30–70) / COLD (<30)** lưu cùng Lead.
- `GET /manage/leads/hot` cho sale lấy danh sách lead nóng, sắp theo điểm.
- FE: badge HOT/WARM/COLD trên `/admin/sales` + util gắn tracking vào các trang chính.

**DoD:** một khách xem cùng 1 xe 5 lần và bấm lưu xe → Lead tương ứng đạt **75 điểm = HOT**.

---

## 2. Phân tích hiện trạng

Đã có sẵn, không cần tạo mới:

| Thành phần | Trạng thái | Ghi chú |
|---|---|---|
| `models/interaction-event.model.js` | có | `sessionId` (bắt buộc), `carId`, `leadId`, `eventType` (String tự do), `occurredAt`, `metadata`; index `(carId, eventType, occurredAt)` và `(leadId, occurredAt)` |
| `models/visitor-session.model.js` | có | `customerId` (nullable), `startedAt`, `lastSeenAt`, `consentState` |
| `models/Lead.js` | có | **chưa có `score`**; có `priority` (LOW/MEDIUM/HIGH/URGENT) — khác nghĩa, giữ nguyên |
| `models/extendedEnums.js` → `PriorityBand` | có | `HOT/WARM/COLD` đã khai báo nhưng chưa ai dùng |
| `services/leadService.js` | có | `createPublicEnquiry`, `listLeads` (populate customer/car/assignedTo), `getLeadById`, `addLeadNote` |
| `middlewares/authMiddleware.js` → `optionalAuth` | có | gắn `req.user`/`req.userId` nếu có token, không thì đi tiếp ẩn danh |
| `middlewares/rateLimiters.js` | có | pattern `createXxxLimiter` |
| `jobs/depositExpiryJob.js` | có | pattern `setInterval(...).unref()` + `start/stop` + `runOnce` — **copy pattern này** |

Hai điểm cần biết trước khi code:

1. **`startDepositExpiryJob()` hiện không được gọi ở đâu** — job deposit là dead code. KAN-97 phải tự wire `startLeadScoringJob()` vào `server.js` sau seeding, đừng lặp lại lỗi này.
2. **FE `/admin/sales` đang gọi `/manage/leads` và `/manage/appointments` — BE chỉ mount `/leads`**, nên FE nhận 404 và rơi về dữ liệu demo (`salesCrmRepository.js` dòng 27-30). Spec này mount thêm `/manage/leads` (cùng router, cùng quyền) để badge chạy trên dữ liệu thật.

---

## 3. Thay đổi Constants

### `src/constants/appConstants.js`

**`ActivityEventType`:** thêm 2 event hệ thống (không nằm trong whitelist public).
```js
  // Lead Scoring (KAN-97)
  LEAD_SCORE_UPDATED:      'LEAD_SCORE_UPDATED',
  INTERACTION_TRACKED:     'INTERACTION_TRACKED',
```

**`Permissions`:** không thêm — dùng `LEAD_READ` sẵn có (ADMIN + SALES_STAFF).

### `src/constants/leadScoringConstants.js` (mới)

Toàn bộ trọng số + ngưỡng nằm một chỗ để dễ chỉnh và để test thuần không cần DB.

```js
/** Whitelist eventType nhận từ POST /track. */
export const TRACKABLE_EVENT_TYPES = Object.freeze([
  'VIEW_CAR', 'WISHLIST_ADD', 'FILTER_APPLY', 'CONTACT_CLICK', 'COMPARE_ADD', 'CALCULATOR_USE',
]);

/** Event bắt buộc có carId (gắn với một xe cụ thể). */
export const CAR_REQUIRED_EVENT_TYPES = Object.freeze(['VIEW_CAR', 'WISHLIST_ADD', 'COMPARE_ADD']);

/** Trọng số gốc của từng loại tương tác. */
export const EVENT_WEIGHTS = Object.freeze({
  VIEW_CAR:       10,
  WISHLIST_ADD:   25,
  COMPARE_ADD:    12,
  CALCULATOR_USE: 10,
  FILTER_APPLY:    3,
  CONTACT_CLICK:  20,
});

/** Event không gắn xe (FILTER_APPLY, CALCULATOR_USE…) chỉ tính nửa trọng số cho từng lead. */
export const GENERAL_EVENT_FACTOR = 0.5;

export const SCORE_MAX = 100;
/** Decay: mỗi 7 ngày tuổi, trọng số của một event còn 90%. */
export const DECAY_FACTOR_PER_WEEK = 0.9;
export const DECAY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Event cũ hơn mốc này bị bỏ qua khi chấm. */
export const EVENT_WINDOW_DAYS = 30;

export const SCORE_BAND = Object.freeze({ HOT: 'HOT', WARM: 'WARM', COLD: 'COLD' });
/** HOT khi score > 70; WARM khi 30 ≤ score ≤ 70; COLD khi < 30. */
export const HOT_THRESHOLD = 70;
export const WARM_THRESHOLD = 30;

/** Stage còn được chấm điểm (lead đã WON/LOST không chấm nữa). */
export const SCORABLE_STAGES = Object.freeze(['NEW', 'CONTACTED', 'QUALIFIED', 'NEGOTIATING']);

/** Cron mặc định 5 phút; override bằng env LEAD_SCORING_INTERVAL_MS. */
export const DEFAULT_SCORING_INTERVAL_MS = 5 * 60 * 1000;
export const HOT_LEADS_MAX_LIMIT = 100;
```

> **Vì sao `VIEW_CAR = 10`:** DoD cần `5 × VIEW_CAR + 1 × WISHLIST_ADD > 70` → `5×10 + 25 = 75`. Nếu để 5 điểm như trực giác ban đầu thì kịch bản DoD chỉ đạt 50 (WARM) và spec sai ngay từ test đầu tiên.

---

## 4. Thay đổi Model

### 4.1 `src/models/Lead.js` — thêm block scoring

```js
    // ── Lead Scoring (KAN-97) ─────────────────────────────────────────
    // `score` là điểm ý định 0-100 tính từ InteractionEvent; `priority`
    // (LOW/MEDIUM/HIGH/URGENT) là mức ưu tiên do sale đặt tay — hai field độc lập.
    score: {
      type: Number, default: 0, min: 0, max: SCORE_MAX, index: true,
    },
    scoreBand: {
      type: String,
      enum: Object.values(SCORE_BAND),
      default: SCORE_BAND.COLD,
      index: true,
    },
    /** Tương tác mới nhất được tính vào điểm. Null khi lead chưa có event nào. */
    lastInteractionAt: { type: Date, default: null },
    /** Lần cuối cron chấm lại lead này. */
    lastScoredAt: { type: Date, default: null },
    /** Số đếm theo loại event tại lần chấm gần nhất — dùng cho tooltip badge. */
    scoreFactors: {
      type: new mongoose.Schema({
        VIEW_CAR:       { type: Number, default: 0 },
        WISHLIST_ADD:   { type: Number, default: 0 },
        COMPARE_ADD:    { type: Number, default: 0 },
        CALCULATOR_USE: { type: Number, default: 0 },
        FILTER_APPLY:   { type: Number, default: 0 },
        CONTACT_CLICK:  { type: Number, default: 0 },
      }, { _id: false }),
      default: undefined,
    },
```

**Index cho danh sách HOT:**
```js
LeadSchema.index({ scoreBand: 1, stage: 1, isActive: 1, score: -1 }, { name: 'hot_leads' });
```

### 4.2 `src/models/interaction-event.model.js`

Thêm enum nhẹ cho `eventType` để chặn dữ liệu rác (vẫn cho phép event do hệ thống ghi):

```js
    eventType: {
      type: String,
      required: true,
      enum: {
        values: [...TRACKABLE_EVENT_TYPES, 'LEAD_ENQUIRY'],
        message: 'Unknown interaction event type.',
      },
    },
```

> Hiện `eventType` là String tự do và **chưa có code nào ghi `InteractionEvent`** (model mới chỉ được đăng ký, không service nào dùng) → đổi sang enum an toàn, không cần migration. `LEAD_ENQUIRY` để dành cho pha sau (chấm điểm ngay khi khách gửi form liên hệ); pha này chưa ghi event đó.

---

## 5. Quy tắc chấm điểm (phần lõi)

### 5.1 Công thức

Với mỗi lead, xét các event trong **30 ngày** gần nhất của **cùng customer**:

```
contribution(event) =
    EVENT_WEIGHTS[eventType]
  × DECAY_FACTOR_PER_WEEK ^ floor(ageDays(event.occurredAt) / 7)
  × (event.carId == null ? GENERAL_EVENT_FACTOR : 1)

score = min(100, round(Σ contribution))
```

- `ageDays` tính tới lúc cron chạy → điểm tự giảm dần mà **không cần ghi đè lũy kế**, tránh lỗi "mỗi 5 phút trừ 10% một lần".
- Event đúng 7 ngày tuổi: hệ số 0.9; 14 ngày: 0.81; 21 ngày: 0.729; ≥ 30 ngày: bị loại.
- Band: `score > 70` → HOT; `30 ≤ score ≤ 70` → WARM; `< 30` → COLD.

### 5.2 Event nào tính cho lead nào

Một event thuộc về một **customer** (qua `event.leadId` nếu có, ngược lại qua `session.customerId`). Với mỗi lead **đang mở** của customer đó (`isActive: true`, `stage ∈ SCORABLE_STAGES`):

| Trường hợp | Có tính? |
|---|---|
| `event.leadId === lead._id` | ✅ full weight |
| `event.carId` khác `lead.car` (cả hai đều có giá trị) | ❌ không tính |
| `event.carId === lead.car` | ✅ full weight |
| `event.carId` có giá trị, `lead.car === null` (lead liên hệ chung) | ✅ full weight |
| `event.carId === null` (FILTER_APPLY, CALCULATOR_USE…) | ✅ × 0.5 cho **mọi** lead mở của customer |

Lead đã `WON`/`LOST` hoặc `isActive: false` **không được chấm** và giữ nguyên điểm cũ (lịch sử).

### 5.3 Ví dụ kiểm chứng DoD

Khách có lead `LD-0001` cho xe X, chưa từng tương tác:

| Event | Số lần | Contribution |
|---|---|---|
| `VIEW_CAR` xe X | 5 | 5 × 10 = 50 |
| `WISHLIST_ADD` xe X | 1 | 25 |
| **Tổng** | | **75 → HOT** ✅ |

Cùng bộ event nhưng xe Y ≠ xe X: lead `LD-0001` chỉ nhận `VIEW_CAR`/`WISHLIST_ADD` của X → 0.

---

## 6. API

### 6.1 Public — `POST /api/v1/track`

Mount trước `router.use('/public', …)` trong `routes/index.js` (hoặc theo sau, không quan trọng — path khác).

**Middleware:** `optionalAuth`, `createTrackLimiter`, `validate(trackEventSchema)`.

**Body:**
```json
{
  "sessionId": "66f0a1…",            // optional — thiếu thì BE tạo VisitorSession mới
  "eventType": "VIEW_CAR",           // required, thuộc TRACKABLE_EVENT_TYPES
  "carId": "66f0b2…",                // required với VIEW_CAR / WISHLIST_ADD / COMPARE_ADD
  "metadata": { "filter": "SUV" }    // optional, object ≤ 1KB
}
```

**Logic (`services/trackingService.js`):**
1. Nếu `sessionId` là ObjectId hợp lệ **và** tồn tại → dùng lại; cập nhật `lastSeenAt = now`; nếu request có `req.user.customer` và `session.customerId` đang null → gán vào (khách vừa đăng nhập giữa phiên).
2. Ngược lại → `VisitorSession.create({ customerId: req.user?.customer ?? null })`.
3. `InteractionEvent.create({ sessionId, carId: carId ?? null, eventType, occurredAt: now, metadata })`.
4. `ActivityLog` **không** ghi cho từng event (sẽ nổ log); chỉ ghi khi cron cập nhật điểm (xem §8) và chỉ khi band đổi.

**Response 201:**
```json
{ "success": true, "message": "Interaction tracked.", "data": { "sessionId": "66f0a1…", "eventId": "66f0c3…" } }
```

**Lỗi:**
| Tình huống | Status | code |
|---|---|---|
| `eventType` ngoài whitelist | 422 | `VALIDATION_ERROR` |
| Thiếu `carId` cho VIEW_CAR/WISHLIST_ADD/COMPARE_ADD | 422 | `VALIDATION_ERROR` |
| Quá giới hạn | 429 | `TRACK_RATE_LIMIT` |
| `carId` không tồn tại | 404 | `CAR_NOT_FOUND` (không ghi event rác) |

**Rate limit (`rateLimiters.js`):**
```js
/**
 * /track là public nên khoá theo IP (không dùng identifyCaller vì route này
 * không đi qua global limiter). 120 event / 5 phút / IP.
 */
export const createTrackLimiter = (max = resolveLimit(process.env.TRACK_RATE_LIMIT, 120)) => rateLimit({
  windowMs: 5 * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${req.ip}`,
  message: { success: false, message: 'Too many tracking events. Slow down.', code: 'TRACK_RATE_LIMIT' },
});
```
120 event / 5 phút / IP — đủ cho một phiên duyệt bình thường, chặn script spam.

### 6.2 Staff — `GET /api/v1/manage/leads/hot`

Trong `leadRoutes.js`, khai báo **trước** `router.get('/:id')`:

```js
/** @route GET /manage/leads/hot?limit= — lead đang mở, band HOT, điểm cao trước. */
router.get('/hot', validateQuery(hotLeadsQuerySchema), leadController.listHotLeads);
```

**Query:** `limit` (1–100, default 20).

**Điều kiện:** `{ isActive: true, stage: { $in: SCORABLE_STAGES }, scoreBand: 'HOT' }`, sort `{ score: -1, lastInteractionAt: -1 }`, populate `customer` (fullName, phone, email), `car` (vehicleCode, make, model, year, price), `assignedTo` (fullName).

**Response 200:** `sendPaginated` với DTO allow-list:
```json
{
  "success": true, "message": "Hot leads retrieved.", "data": [
    { "id": "…", "leadCode": "LD-0001", "score": 75, "scoreBand": "HOT",
      "scoreFactors": { "VIEW_CAR": 5, "WISHLIST_ADD": 1, "COMPARE_ADD": 0,
                        "CALCULATOR_USE": 0, "FILTER_APPLY": 0, "CONTACT_CLICK": 0 },
      "lastInteractionAt": "2026-12-05T09:12:00.000Z",
      "stage": "NEW", "customer": {…}, "car": {…}, "assignedTo": {…} }
  ],
  "meta": { "page": 1, "limit": 20, "total": 3, "totalPages": 1, "hasNext": false, "hasPrev": false }
}
```

### 6.3 Bonus — mount thêm `/manage/leads`

`routes/index.js`:
```js
router.use('/leads', leadPublicRoutes);
router.use('/leads', leadRoutes);
router.use('/manage/leads', leadRoutes);   // KAN-97: FE /admin/sales đã gọi path này
```

Router tự kiểm `verifyToken + requireRole(ADMIN, SALES_STAFF)` nên không nới quyền. Không đổi hành vi cũ, chỉ làm FE hết rơi về demo.

---

## 7. Schema Joi — `src/routes/trackSchemas.js` (mới)

```js
import Joi from 'joi';
import { TRACKABLE_EVENT_TYPES, CAR_REQUIRED_EVENT_TYPES } from '../constants/leadScoringConstants.js';

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/);

export const trackEventSchema = Joi.object({
  sessionId: objectId.allow(null),
  eventType: Joi.string().valid(...TRACKABLE_EVENT_TYPES).required(),
  carId: objectId.when('eventType', {
    is: Joi.string().valid(...CAR_REQUIRED_EVENT_TYPES),
    then: Joi.required(),
    otherwise: Joi.allow(null),
  }),
  metadata: Joi.object().max(20).custom((value, helpers) => {
    if (JSON.stringify(value).length > 1024) return helpers.message('metadata must be at most 1 KB.');
    return value;
  }).allow(null),
}).unknown(false);

export const hotLeadsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
});
```

---

## 8. Cron — `src/jobs/leadScoringJob.js` (mới)

Copy khung của `depositExpiryJob.js`:

```js
import { runLeadScoring } from '../services/leadScoringService.js';
import { DEFAULT_SCORING_INTERVAL_MS } from '../constants/leadScoringConstants.js';
import logger from '../utils/logger.js';

const intervalMs = () => Number(process.env.LEAD_SCORING_INTERVAL_MS) || DEFAULT_SCORING_INTERVAL_MS;
let timer = null; let running = false;
const tick = async () => { if (running) return; running = true; try { await runLeadScoring(); } finally { running = false; } };

export const startLeadScoringJob = () => {
  if (timer) return;
  timer = setInterval(tick, intervalMs());
  timer.unref();                    // không giữ process sống
  setTimeout(tick, 5_000).unref();  // chấm bù sau restart
  logger.info(`[lead-scoring] started (every ${Math.round(intervalMs() / 1000)}s).`);
};
export const stopLeadScoringJob = () => { clearInterval(timer); timer = null; };
```

Wire trong `server.js`, **sau** `seedShowroomServices()`:

```js
import { startLeadScoringJob, stopLeadScoringJob } from './jobs/leadScoringJob.js';
// …
startLeadScoringJob();
// trong shutdown(): stopLeadScoringJob();
```

### `services/leadScoringService.js` — `runLeadScoring({ now })`

1. **Chọn khách cần chấm:** `InteractionEvent` trong `[now − 30d, now]` → nhóm theo `leadId` hoặc `sessionId → VisitorSession.customerId`. Không có customer thì bỏ.
2. **Tập lead cần chấm:** union của
   - leads đang mở của các customer vừa có event, và
   - leads có `score > 0` và `lastInteractionAt < now − 7d` (để điểm già tự rơi về 0 dù cron chạy nhiều lần cũng không trừ lặp).
3. Với mỗi lead: lọc event theo §5.2, tính `score` + `scoreFactors` (§5.1) → `updateOne` set `score`, `scoreBand`, `lastInteractionAt` (max `occurredAt`), `lastScoredAt = now`.
4. **Audit chỉ khi band đổi:** ghi `ActivityLog` `LEAD_SCORE_UPDATED` với `changes.before {score, scoreBand}`, `changes.after`, `metadata.reason: 'cron'`. Không ghi khi điểm đổi trong cùng band (tránh 288 log/ngày/lead).
5. Trả `{ scored, hot, warm, cold }` để log/job test.
6. Toàn bộ bằng `bulkWrite` theo lô 200 — không gọi `save()` từng lead.

> **Vì sao có bước "lead điểm già":** nếu chỉ chấm leads có event mới, một lead 75 điểm sẽ HOT vĩnh viễn sau khi khách ngừng tương tác; bước này cho decay chạy đúng dù không có event mới.

---

## 9. Frontend

### 9.1 `src/utils/trackEvent.js` (mới)

```js
import api from '../services/api'

const KEY = 'trustcar_track_session'
const dnt = () => typeof navigator !== 'undefined' && (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true)

/** Fire-and-forget: không await ở nơi gọi, không retry, nuốt lỗi. */
export function trackEvent(eventType, carId = null, metadata = null) {
  if (dnt()) return
  if (typeof window === 'undefined') return
  try {
    const sessionId = window.sessionStorage.getItem(KEY)
    api.post('/track', { sessionId: sessionId || undefined, eventType, carId: carId || undefined, metadata: metadata || undefined })
      .then((res) => { const id = res.data?.data?.sessionId; if (id) window.sessionStorage.setItem(KEY, id) })
      .catch(() => {})
  } catch { /* sessionStorage bị chặn → bỏ qua */ }
}
```

### 9.2 Gắn tracking vào các điểm chạm

| Trang | Hook | Event |
|---|---|---|
| `pages/CarDetail/CarDetailPage.jsx` | `useEffect` theo `stockCode`, debounce 1 lần / lần mở | `VIEW_CAR` |
| `features/saved-cars/components/SaveCarButton.jsx` | sau khi lưu thành công | `WISHLIST_ADD` |
| `features/vehicle-compare/pages/ComparePage.jsx` | khi bấm "Thêm vào so sánh" | `COMPARE_ADD` |
| `pages/Cars/CarsPage.jsx` | khi đổi bộ lọc (debounce 800ms) | `FILTER_APPLY` |
| `features/installment-calculator/pages/InstallmentPage.jsx` | mount 1 lần | `CALCULATOR_USE` |
| `pages/Contact/ContactPage.jsx` | click số hotline | `CONTACT_CLICK` |

Tất cả đều **không chặn UI**: gọi sau hành động, bỏ qua lỗi.

### 9.3 Badge trên `/admin/sales`

- `salesCrmMappers.toLeadVM`: thêm `score: raw.score ?? 0`, `scoreBand: raw.scoreBand ?? 'COLD'`, `scoreFactors: raw.scoreFactors ?? null`.
- `LeadTable`: thêm cột **"Mức độ"** giữa "Giai đoạn" và "Nguồn":
  ```jsx
  <th>Mức độ</th>
  // …
  <td><ScoreBadge lead={lead} /></td>
  ```
  `ScoreBadge` = `<Tag color={HOT:'red',WARM:'gold',COLD:'default'}>HOT · 75</Tag>` kèm `<Tooltip>` liệt kê `scoreFactors` ("5 lượt xem xe, 1 lần lưu xe").
- (Tuỳ chọn, khuyến nghị) `StaffFilters` cho tab lead: checkbox "Chỉ lead HOT" lọc client-side theo `scoreBand === 'HOT'`.
- `salesCrmConstants.js`: thêm
  ```js
  export const SCORE_BAND_COLOR = { HOT: 'red', WARM: 'gold', COLD: 'default' }
  export const SCORE_BAND_LABEL = { HOT: 'Nóng', WARM: 'Ấm', COLD: 'Nguội' }
  ```

---

## 10. Test Plan

### 10.1 Pure rules — `tests/lead-scoring-rules.test.js`

| # | Setup | Expected |
|---|---|---|
| T1 | 5 × `VIEW_CAR` cùng xe + 1 × `WISHLIST_ADD`, tất cả tuổi 0 | `score = 75`, band HOT |
| T2 | Chỉ `WISHLIST_ADD` | 25 → COLD |
| T3 | 3 × `VIEW_CAR` | 30 → WARM (biên dưới) |
| T4 | 7 × `VIEW_CAR` | 70 → WARM (biên trên, chưa HOT) |
| T5 | 8 × `VIEW_CAR` | 80 → HOT |
| T6 | 20 × `VIEW_CAR` | clamp 100 |
| T7 | 1 × `VIEW_CAR` tuổi 8 ngày | 9 (10 × 0.9, làm tròn) |
| T8 | 1 × `VIEW_CAR` tuổi 15 ngày | 8.1 → 8 |
| T9 | 1 × `VIEW_CAR` tuổi 31 ngày | 0 (ngoài cửa sổ 30 ngày) |
| T10 | 2 × `FILTER_APPLY` (không carId) | 2 × 3 × 0.5 = 3 |
| T11 | Event xe Y khi lead gắn xe X | 0 |
| T12 | Event xe Y khi lead `car = null` | tính full |
| T13 | `event.leadId` khớp lead, khác car | tính full (ưu tiên leadId) |

### 10.2 Endpoint track — `tests/track-endpoint.test.js`

| # | Setup | Expected |
|---|---|---|
| T14 | POST hợp lệ, không sessionId | 201, trả `sessionId` mới, tạo VisitorSession |
| T15 | POST lần 2 cùng sessionId | 201, dùng lại session, `lastSeenAt` cập nhật, không tạo session mới |
| T16 | POST với token CUSTOMER | session có `customerId` = `req.user.customer` |
| T17 | `eventType: "HACK"` | 422 |
| T18 | `VIEW_CAR` thiếu `carId` | 422 |
| T19 | `FILTER_APPLY` không có carId | 201 |
| T20 | `carId` không tồn tại | 404 CAR_NOT_FOUND, không ghi event |
| T21 | 121 request / 5 phút cùng IP | request 121 → 429 `TRACK_RATE_LIMIT` |
| T22 | `metadata` > 1KB | 422 |

### 10.3 Service aggregate — `tests/lead-scoring-service.test.js`

Dùng harness in-memory (xem [[backend-test-harness-quirks]]); thêm fake `VisitorSession` + `InteractionEvent` theo pattern `fakeAppointmentModels.js`.

| # | Setup | Expected |
|---|---|---|
| T23 | **DoD:** 5 VIEW_CAR + WISHLIST_ADD qua 2 session khác nhau, 1 lead mở | lead `score=75`, `scoreBand=HOT`, `lastScoredAt` set |
| T24 | Lead `WON` có event mới | không đổi điểm, không `lastScoredAt` mới |
| T25 | Lead `LOST` | như T24 |
| T26 | Khách có 2 lead (xe X, xe Y), chỉ event xe X | lead X = 75, lead Y = 0 |
| T27 | Lead 75 điểm, event cũ 8 ngày, không event mới | score 68 → WARM (decay chạy dù không event mới) |
| T28 | Band đổi COLD→HOT | có đúng 1 `ActivityLog` `LEAD_SCORE_UPDATED` |
| T29 | Score đổi 76→75 trong cùng band | **không** ghi log |
| T30 | Event của session không có customerId | bỏ qua, không throw |
| T31 | 2 lần chạy cron liên tiếp cùng `now` | kết quả idempotent (score không trôi) |

### 10.4 Endpoint hot — `tests/hot-leads-endpoint.test.js`

| # | Setup | Expected |
|---|---|---|
| T32 | GET với SALES_STAFF | 200, chỉ band HOT, sort score desc |
| T33 | GET với CUSTOMER | 403 |
| T34 | Lead HOT nhưng `stage=WON` | không xuất hiện |
| T35 | `limit=500` | 422 (max 100) |
| T36 | Không có lead HOT | 200, `data: []`, `meta.total = 0` |

### 10.5 FE

| # | Loại | Mô tả |
|---|---|---|
| F1 | unit — `salesCrmMappers.test.js` | `toLeadVM` mang `score/scoreBand`; thiếu field → mặc định 0/COLD |
| F2 | unit — `trackEvent.test.js` | gọi `api.post('/track', …)` đúng payload; lưu sessionId trả về; nuốt lỗi; tôn trọng DNT |
| F3 | component | `LeadTable` render `ScoreBadge` đúng màu + điểm |

---

## 11. Thứ tự triển khai

1. `constants/leadScoringConstants.js` + 2 `ActivityEventType`.
2. `Lead.js` (score block + index) + `interaction-event.model.js` (enum).
3. `services/leadScoringRules.js` (hàm thuần: `contributionOf`, `bandOf`, `scoreLead`) + test T1–T13.
4. `services/trackingService.js` + `trackSchemas.js` + route `/track` + `createTrackLimiter` + test T14–T22.
5. `services/leadScoringService.js` + `jobs/leadScoringJob.js` + wire `server.js` + test T23–T31.
6. `leadController.listHotLeads` + route `/hot` + mount `/manage/leads` + test T32–T36.
7. FE: `trackEvent.js` + gắn 6 điểm chạm + badge `ScoreBadge` + cột "Mức độ" + filter HOT + test F1–F3.
8. Smoke end-to-end: chạy server → xem 1 xe 5 lần + lưu xe → chờ cron (hoặc `LEAD_SCORING_INTERVAL_MS=10000`) → `/admin/sales` thấy badge HOT.

---

## 12. Rủi ro & lưu ý

- **Không chấm điểm lead đã đóng** (`WON`/`LOST`/`isActive=false`): nếu chấm, lead thua vẫn nhảy HOT và làm nhiễu danh sách.
- **Không ghi `ActivityLog` cho từng event** — sẽ sinh hàng nghìn bản ghi/ngày và làm chậm trang nhật ký; chỉ log khi band đổi.
- **Decay theo tuổi event, không trừ lũy kế**: cron chạy 5 phút/lần, nếu trừ `score * 0.9` mỗi lần sẽ bốc hơi điểm trong 1 giờ. Công thức ở §5.1 là hàm thuần của `(events, now)` nên chạy lại bao nhiêu lần cũng cho cùng kết quả.
- **`priority` vs `scoreBand`**: hai field khác nhau, đừng map lẫn. `priority` sale đặt tay; `scoreBand` máy tính.
- **Track endpoint là public**: cần limiter + whitelist event + `carId` phải tồn tại; không bao giờ nhận `leadId`/`customerId` từ client (BE tự suy từ session/token).
- **`VISITOR_SESSION` không có TTL**: session rác sẽ tích tụ; chấp nhận trong phạm vi đồ án, ghi chú để pha sau thêm TTL index 90 ngày.
- **FE đang fallback demo**: sau khi mount `/manage/leads`, `/admin/sales` chuyển sang dữ liệu thật — cần smoke test lại tab lịch hẹn vì `/manage/appointments` vẫn 404 (ngoài scope KAN-97, nhưng nếu muốn đồng bộ thì mount tương tự ở ticket khác).
