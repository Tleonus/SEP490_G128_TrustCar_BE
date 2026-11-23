# KAN-91 – Đăng bài xe lên Facebook Page bằng Graph API

Tài liệu cấu hình cho Backend. Nếu chưa làm các bước dưới đây, endpoint sẽ trả
`503 FACEBOOK_NOT_CONFIGURED` kèm tên biến còn thiếu — **không có bài nào được đăng giả lập**.

## 1. API

```
POST /api/v1/marketing/facebook/publish
Authorization: Bearer <access token>
Role: ADMIN
Body: { "carId": "<ObjectId>", "caption": "<nội dung bài viết>", "imageUrl": "https://..." (tuỳ chọn) }
```

- `caption` bắt buộc, 1–5000 ký tự. Frontend gửi caption của phương án đang chọn + hashtag.
- `imageUrl` bỏ trống thì Backend dùng ảnh chính (primary) của xe qua `resolveShareImage`.
  Ảnh phải là URL công khai (Cloudinary của TrustCar đáp ứng) — Facebook tải ảnh từ server Facebook,
  nên `localhost` sẽ không dùng được.

Thành công – `201`:

```json
{
  "success": true,
  "message": "Post published to the Facebook Page successfully.",
  "data": {
    "postId": "1234567890_9876543210",
    "permalinkUrl": "https://www.facebook.com/1234567890/posts/9876543210",
    "pageId": "1234567890",
    "publishedAt": "2026-11-23T09:30:00.000Z"
  }
}
```

Lỗi – mã ổn định cho Frontend:

| HTTP | code | Ý nghĩa |
|------|------|---------|
| 503 | `FACEBOOK_NOT_CONFIGURED` | Thiếu `FACEBOOK_PAGE_ID` / `FACEBOOK_PAGE_ACCESS_TOKEN` |
| 502 | `FACEBOOK_TOKEN_INVALID` | Token sai, hết hạn hoặc bị thu hồi (Graph code 190) |
| 403 | `FACEBOOK_PERMISSION_DENIED` | Token thiếu `pages_manage_posts`, hoặc đang dùng User token thay vì Page token (Graph code 10/200/803) |
| 502 | `FACEBOOK_PAGE_NOT_ACCESSIBLE` | `FACEBOOK_PAGE_ID` là trang cá nhân / ID sai / Page của token khác (Graph code 100, subcode 33) |
| 429 | `FACEBOOK_RATE_LIMIT` | Facebook giới hạn tần suất (code 4/17/32/613/80004) |
| 429 | `FACEBOOK_DAILY_LIMIT` | Vượt hạn mức đăng/ngày của TrustCar (`FACEBOOK_DAILY_PUBLISH_LIMIT`) |
| 502 | `FACEBOOK_PUBLISH_FAILED` | Facebook từ chối vì lý do khác |
| 502 | `FACEBOOK_UNREACHABLE` | Server không gọi được graph.facebook.com |
| 422 | `FACEBOOK_NO_IMAGE` | Xe không có ảnh công khai |
| 422 | `CAR_NOT_ADVERTISABLE` | Xe không ở trạng thái đang bán |
| 404 | `CAR_NOT_FOUND` | Không tìm thấy xe |

## 2. Phải là Facebook **Page**, không phải trang cá nhân

Graph API chỉ đăng được lên **Page** (Trang). Trang cá nhân (profile) không đăng được:
Facebook đã bỏ quyền `publish_actions` từ 2018, nên mọi cách gọi Graph API lên profile đều lỗi
(`100/33` hoặc `200`). Vì vậy: **dùng tài khoản cá nhân hiện có để tạo một Page "TrustCar"**
(tài khoản đó trở thành admin của Page) — không tạo thêm tài khoản cá nhân mới (vi phạm chính sách
tên thật của Facebook, dễ bị khoá, và cũng không giải quyết được gì vì vẫn là profile).

### 2.1. Tạo Page TrustCar

1. Đăng nhập tài khoản cá nhân → <https://www.facebook.com/pages/create>.
2. Đặt tên Page (ví dụ **TrustCar**), chọn hạng mục *Car dealership* (Đại lý xe hơi), điền mô tả,
   ảnh đại diện, ảnh bìa → **Create Page**.
3. Vào Page → **Settings → Page setup**: thêm ảnh, mô tả, địa chỉ showroom; có thể mời thêm
   admin/editor về sau.
4. Lấy **Page ID**: Page → **About → Page ID** (dãy số), hoặc gọi
   `GET /me/accounts?fields=id,name,access_token` bằng User token có `pages_show_list`.
   Đây chính là giá trị `FACEBOOK_PAGE_ID`.

> Page ID và Page Access Token của **trang cá nhân** (`facebook.com/hai.ang.259289`) không dùng
> được cho API này. Chỉ lấy từ Page TrustCar vừa tạo.

## 3. Cấu hình cần có (bắt buộc)

Thêm vào `.env` của Backend rồi **khởi động lại server**:

```ini
FACEBOOK_PAGE_ID=1234567890
FACEBOOK_PAGE_ACCESS_TOKEN=EAAG...   # LONG-LIVED PAGE TOKEN, không phải User token
FACEBOOK_GRAPH_VERSION=v24.0         # tuỳ chọn
FACEBOOK_DAILY_PUBLISH_LIMIT=10      # tuỳ chọn
```

### 3.1. Meta App

1. Vào <https://developers.facebook.com/apps> → **Create app** → use case *Manage everything on your Page*
   (hoặc Business).
2. App phải **Live** nếu muốn đăng lên Page mà người dùng không nằm trong nhóm tester của app.
   Ở chế độ Development chỉ admin/developer/tester của app đăng được — với đồ án nội bộ,
   thêm tài khoản admin vào **App Roles** là đủ, không cần App Review.
3. Thêm sản phẩm **Facebook Login for Business** (hoặc dùng Graph API Explorer) để lấy token.

### 3.2. Page Access Token (long-lived)

1. <https://developers.facebook.com/tools/explorer/> → chọn App → **Get User Access Token**
   với quyền: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`.
2. Gọi `GET /me/accounts` → lấy `access_token` của Page (đây mới là **Page token**).
3. Đổi sang long-lived: <https://developers.facebook.com/tools/debug/accesstoken/> →
   *Extend Access Token* (Page token lấy qua Page đã gắn với long-lived User token thường đã dài hạn;
   kiểm tra bằng Debug Token).
4. Dán vào `FACEBOOK_PAGE_ACCESS_TOKEN`. Không commit token vào git.

### 3.3. Quyền (permissions)

| Quyền | Dùng để |
|-------|---------|
| `pages_manage_posts` | **Bắt buộc** – tạo bài viết/ảnh trên Page |
| `pages_read_engagement` | Đọc thông tin Page (kiểm tra token) |
| `pages_show_list` | Liệt kê Page để lấy Page token |

Với app đang Live và người dùng ngoài nhóm quản trị app, `pages_manage_posts` cần **App Review**
(App Review → Permissions and features). Nếu chỉ nội bộ showroom dùng, có thể giữ app ở Development
và thêm tài khoản Admin vào App Roles.

## 4. Kiểm tra nhanh bằng curl

```bash
# 1) Token còn sống?
curl "https://graph.facebook.com/v24.0/me?access_token=$FACEBOOK_PAGE_ACCESS_TOKEN"

# 2) Đăng thử qua Backend
curl -X POST http://localhost:5000/api/v1/marketing/facebook/publish \
  -H "Authorization: Bearer <admin access token>" \
  -H "Content-Type: application/json" \
  -d '{"carId":"<car _id>","caption":"Xe đẹp, giá tốt. #TrustCar"}'
```

Nếu bước 1 trả `{"error":{"code":190,...}}` → token sai/hết hạn.
Nếu bước 2 trả `FACEBOOK_PERMISSION_DENIED` → token thiếu `pages_manage_posts`.

## 5. Ghi chú vận hành

- Bài đăng là **thật và công khai**. Đăng nhầm vẫn xoá được bằng Graph API:
  `DELETE /{post-id}` với Page token có `pages_manage_posts` (hoặc `deleteCarPost` nếu cần thêm
  endpoint). Cách khác: mở bài viết trên Page rồi xoá thủ công.
- `postId` trả về có dạng `<pageId>_<postId>`; `permalinkUrl` đã dựng sẵn dạng
  `https://www.facebook.com/<pageId>/posts/<postId>`.
- Giới hạn của TrustCar: `FACEBOOK_DAILY_PUBLISH_LIMIT` (mặc định 10 bài/ngày/tài khoản Admin).
- Mỗi lần đăng ghi một bản ghi `ActivityLog` với `eventType = CAR_PUBLISHED_FACEBOOK`.
- Khi chưa cấu hình, nút "Đăng lên Facebook" trên Admin hiển thị đúng lỗi cấu hình thiếu,
  còn nút "Mở Facebook (thủ công)" vẫn dùng được như trước.
