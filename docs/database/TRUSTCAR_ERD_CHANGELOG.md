# TrustCar ERD — Ghi chú sửa đổi

File sơ đồ: **`trustcar_erd.drawio`** — **1 trang duy nhất**, đủ 30 bảng, mở bằng diagrams.net / draw.io. Kèm `trustcar_erd_preview.png` để xem nhanh không cần mở draw.io (ảnh do mình tự vẽ, không phải xuất từ draw.io nên chi tiết có thể hơi khác).

| | Bản cũ | Bản mới |
|---|---|---|
| Bảng | 30 | 30 (tất cả đều có đường nối) |
| Cột | 262 | 277 |
| Quan hệ (đường nối) | 49 (1 cạnh vẽ đôi, 1 cạnh gộp 2 khóa; System Setting đứng riêng) | 52 (mỗi khóa ngoại đúng 1 đường) |
| Màu sắc | Nhiều màu | 1 màu chủ đạo (xanh đậm) + xanh nhạt cho dòng FK + xám cho dòng ràng buộc |

## 1. Cách đọc bản vẽ

- Toàn bộ 30 bảng nằm trên **một trang**, bảng sắp thành các cột; đường nối vuông góc, ký hiệu chân chim: `‖` đúng 1 · `○|` 0..1 · `○<` 0..N. Chú giải nằm ngay dưới tiêu đề.
- **Chữ đậm** = khóa chính (PK) · **nền xanh nhạt** = khóa ngoại (FK) · UQ = duy nhất · `?` sau kiểu dữ liệu = cho phép NULL · **dòng nền xám** = ràng buộc nghiệp vụ gắn với bảng.
- **Đường nối:** 0 đường đè lên nhau, 0 đường đi xuyên qua bảng. Còn **10 chỗ hai đường cắt ngang nhau** (vẽ dạng nhảy vòng nhỏ, không dính vào nhau).

> **Vì sao còn 10 chỗ cắt mà không phải 0?** Mình kiểm tra bằng thuật toán: sơ đồ quan hệ của 30 bảng này **không thể vẽ phẳng** (không cắt nhau là bất khả thi). Lý do: bộ ba **User – Customer – Lead** đều cùng nối với **Appointment, Sale Record và Chat Conversation** — cấu trúc này buộc phải có ít nhất vài chỗ cắt, bất kể sắp xếp thế nào. Mình đã thử hàng chục cách sắp bảng + nối lại từng đường; 10 là kết quả tốt nhất đạt được. Muốn ít hơn nữa thì phải bớt quan hệ hoặc chấp nhận chia nhiều trang.

## 2. Lỗi trong file sơ đồ → đã sửa

| # | Lỗi cũ | Đã sửa |
|---|---|---|
| A1 | Cạnh User → User (created_by) bị vẽ **2 lần** | Giữ 1 cạnh |
| A2 | Sales Task có 3 FK nhưng **2 đường** (assigned/created chung 1 đường) | Mỗi FK 1 đường riêng |
| A3 | Đường nối không có ký hiệu, cardinality chỉ là chữ "1 : N" | Ký hiệu **chân chim** chuẩn, tự phân biệt 1 / 0..1 / 0..N theo FK có NULL hay không |
| A4 | Không có kiểu dữ liệu, ô cột lẫn ghi chú ("public display name", "Number"...) | Mỗi cột có kiểu (`varchar(n)`, `decimal(15,0)`, `datetime`, `enum`, `json`, `id`...) và dấu `?` = cho phép NULL; ghi chú chuyển thành dòng ràng buộc riêng |
| A5 | Không liệt kê giá trị enum | Có bảng từ điển enum (mục 6 bên dưới) |
| A6 | Khung bảng cố định chiều cao, nội dung có thể bị cắt | Mỗi dòng cột là một ô riêng, khung tính theo số dòng — không bị cắt |
| A7 | Đường nối chồng chéo, nhiều màu khó nhìn | Bố cục tối ưu bằng thuật toán + nối lại từng đường; màu đơn giản hóa |

## 3. Lỗi thiết kế dữ liệu → đã sửa

| # | Vấn đề | Cách sửa |
|---|---|---|
| B1 | **Sale Record không có người mua** (chỉ có `lead_code` nullable) | Thêm `customer_id` NOT NULL |
| B2 | **Feedback** không gắn khách, không biết ai duyệt | Thêm `customer_id` (NULL), `reviewed_by_user_id`, `reviewed_at` |
| B3 | Cột dẫn xuất lưu cứng, dễ lệch | **Bỏ** `Car.days_in_stock`, `Car.price_drop_count`, `Price History.drop_amount` (tính khi truy vấn). `aging_category` giữ lại nhưng ghi rõ là cột cache, cập nhật bằng job hằng ngày |
| B4 | `customer_id` và `lead_code` trùng thông tin ở nhiều bảng | **Interaction Event**: bỏ `customer_id` (suy ra từ Visitor Session). Các bảng còn lại (Appointment, Sale Record, Chat Conversation) giữ cả hai nhưng thêm ràng buộc: *có `lead_code` ⇒ `Lead.customer_id` = `customer_id`* |
| B5 | Thiếu ràng buộc có điều kiện | Ghi thành dòng CK ngay trong bảng (danh sách ở mục 5) |
| B6 | Customer Preference / Lead Requirement trùng 8 cột; User/Customer trùng thông tin; SĐT khách không unique | Giữ 2 bảng (một là hồ sơ lâu dài, một là snapshot theo từng lead) nhưng thống nhất tên cột. `Customer.phone_number` nay **UQ** (chuẩn hóa E.164) để chống trùng khách |
| B7 | Lead Vehicle Interest mơ hồ (1 dòng hay nhiều dòng / cặp lead–xe) | Quy định **UQ (lead_code, stock_code)**: 1 dòng/cặp, `interest_type` = trạng thái mới nhất |
| B8 | Đặt tên không đồng nhất | Xem bảng đổi tên ở mục 4 |
| B9 | Mốc thời gian không đồng đều | Thêm `created_at` / `updated_at` cho các bảng nghiệp vụ còn thiếu (User, Customer, Lead, Lead Task, Appointment, Sale Record, Car, Content Item, System Setting) |
| B10 | Activity Log chỉ có 1 chuỗi tóm tắt | Thêm `change_detail` (JSON trước/sau) |
| B11 | **System Setting không có khóa ngoại nào** — đứng trơ trọi, không nối được vào sơ đồ | Thêm `updated_by_user_id` (FK → User, NULL được): ghi lại Admin nào đổi cài đặt. *Đây là cột mình thêm để nối bảng; nếu không muốn, xóa cột và bảng này sẽ lại đứng riêng.* |

## 4. Bảng đổi tên (cũ → mới)

**Tên bảng:** `Sales Task` → `Lead Task` · `PriceHistory` → `Price History`

**Tên cột** (mọi khóa ngoại trỏ User giờ kết thúc bằng `_user_id`):

| Bảng | Cũ | Mới |
|---|---|---|
| User | `phone` | `phone_number` |
| User | `created_by` | `created_by_user_id` |
| Lead | `assigned_to` | `assigned_user_id` |
| Lead Activity | `user_id` | `actor_user_id` |
| Lead Task | `assigned_to` / `created_by` | `assigned_user_id` / `created_by_user_id` |
| Appointment | `assigned_staff_id` | `assigned_user_id` |
| Chat Conversation | `assigned_staff_id` | `assigned_user_id` |
| Sale Record | `recorded_by` | `recorded_by_user_id` |
| Activity Log | `user_id` | `actor_user_id` |
| Price History | `car` / `changed_by` | `stock_code` / `changed_by_user_id` |
| Customer Preference | `profile_source` | `information_source` |

Trong code Mongoose: các tên trên viết dạng camelCase (vd. `assignedUserId`), tham chiếu tới Car/Lead/Chat dùng `carId` / `leadId` / `conversationId` (ObjectId).

## 5. Ràng buộc cần cài (đã có trong code MongoDB, trừ các mục ghi chú)

| Ràng buộc | Trong code |
|---|---|
| `auth_provider = LOCAL` ⇒ `password_hash` bắt buộc | Schema (`required` có điều kiện) |
| Appointment: `SERVICE` ⇒ `service_id`; `VIEW_CAR`/`TEST_DRIVE` ⇒ `stock_code` | Hook `pre('validate')` |
| Chat Message: `STAFF` ⇒ `sender_user_id` | Schema (`required` có điều kiện) |
| Recommendation Batch: ≥ 1 trong (customer, session, lead) | Hook `pre('validate')` |
| Car Image: tối đa 1 `is_cover` / xe | Hook `pre('validate')` |
| Sale Record: mỗi xe tối đa 1 giao dịch `COMPLETED` | Partial unique index |
| Lead Vehicle Interest: UQ (lead, xe) | Unique index |
| Customer.phone_number, User.email, Car.vin: unique | Unique index |
| Car Model: UQ (brand, model_name) | Unique index |
| `Lead.customer_id` = `customer_id` (Appointment / Sale Record / Chat Conversation) | **Phải kiểm trong service** (Mongo không có composite FK) |
| Cập nhật `aging_category` hằng ngày | **Cần viết cron** |

## 6. Từ điển enum

Giá trị ERD cũ không ghi → mình tự đề xuất (đánh dấu `[INFERRED]` trong `enums.ts`); bạn chỉnh cho khớp quy trình thật của showroom.

| Enum | Giá trị |
|---|---|
| `AuthProvider` | LOCAL · FIREBASE |
| `ProfileSource` | FORM · AI · STAFF |
| `InterestType` | VIEW · COMPARE · SAVED · ASKED |
| `SenderType` | CUSTOMER · AI · STAFF · SYSTEM |
| `AgingCategory` | FRESH · SLOW · STAGNANT |
| `InventoryType` | OWNED · CONSIGNMENT |
| `FeedbackStatus` | PENDING · APPROVED · REJECTED |
| `RecordStatus` | ACTIVE · INACTIVE |
| `UserStatus` | ACTIVE · INACTIVE · LOCKED |
| `LeadStage` | NEW · CONTACTED · QUALIFIED · NEGOTIATING · WON · LOST |
| `PriorityBand` | HOT · WARM · COLD |
| `LeadTaskStatus` | PENDING · COMPLETED · CANCELLED |
| `AppointmentType` | VIEW_CAR · TEST_DRIVE · SERVICE · VALUATION |
| `AppointmentStatus` | REQUESTED · CONFIRMED · COMPLETED · CANCELLED · NO_SHOW |
| `SaleStatus` | COMPLETED · VOIDED |
| `ConversationStatus` | OPEN · CLOSED |
| `ConsentState` | PENDING · ACCEPTED · DECLINED |
| `ContentStatus` | DRAFT · PUBLISHED · HIDDEN |
| `CarStatus` | AVAILABLE · RESERVED · SOLD · HIDDEN |
| `BodyType` | SEDAN · SUV · HATCHBACK · MPV · PICKUP · COUPE · CONVERTIBLE · OTHER |
| `FuelType` | PETROL · DIESEL · HYBRID · ELECTRIC |
| `Transmission` | AUTOMATIC · MANUAL |

Các cột kiểu chuỗi tự do (chưa chuyển thành enum vì ERD không giới hạn): `Lead.source`, `Lead.request_type`, `Lead Task.task_type`, `Lead Activity.activity_type`, `Interaction Event.event_type`, `Recommendation Batch.algorithm_type`, `Activity Log.action`, `Content Item.type`, `usage_type`, `purchase_timeline`, `preferred_contact_channel`.

## 7. Cố ý KHÔNG thay đổi / chưa thêm

- **Không thêm bảng mới.** Các phần sau tùy phạm vi đồ án, bạn quyết định rồi báo mình: Notification (hiện chỉ có số `notified_leads_count`), đặt cọc/thanh toán, giá nhập & chủ xe ký gửi, yêu cầu định giá/thu mua, kiểm định xe (nếu định vị "Certified Pre-Owned").
- Giữ cả `Customer Preference` và `Lead Requirement` (xem B6).
- Giữ `Lead.assigned_user_id` NULL được (chưa phân công); chưa có bảng lịch sử phân công lại.

## 8. Mình đã kiểm tra gì — và chưa kiểm tra gì

**Đã kiểm tra tự động:**
- Đọc ngược chính file `.drawio` đã xuất: 52 đường nối; **0 đường đè nhau, 0 đường xuyên qua bảng, 10 chỗ cắt ngang**; mọi đầu mút nằm đúng trên viền bảng; mọi đoạn vuông góc; id không trùng.
- 52 cột FK ↔ 52 đường nối (khớp 1–1); cả 30 bảng đều có ít nhất một đường nối; mỗi bảng xuất hiện đúng 1 lần.
- Code Mongoose (Express): 26 kiểm thử Jest đều đạt trên cả Mongoose 8 và 9 (ràng buộc, virtual, ép kiểu ObjectId, mọi `ref` trỏ đúng model); so khớp 30 bảng ERD ↔ model, không lệch.

**Chưa kiểm tra:**
- Chưa mở file trong draw.io thật (mình không có giao diện). Nếu thấy chữ bị cắt, dấu chân chim ngược chiều hay đường nối lệch, báo mình kèm ảnh chụp.
- Chưa chạy schema với MongoDB thật (chưa thử index, transaction).
- Nếu bạn **kéo bảng** trong draw.io, các điểm gấp khúc của đường nối đứng yên nên đường có thể bị xấu — hãy báo mình để vẽ lại thay vì kéo tay.
