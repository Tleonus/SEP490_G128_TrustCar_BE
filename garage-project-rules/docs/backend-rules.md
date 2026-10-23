# Backend — Node.js, Express, Mongoose, MongoDB

## Bắt buộc trước khi sửa

Đọc [docs/README.md](README.md), các tài liệu chung được chỉ định và file này. **Mọi thay đổi liên quan database phải giải thích và xin phép trước**, theo [database-rules.md](database-rules.md), kể cả sửa query không đổi schema.

## Phân tầng và lỗi

- Luồng chính: `route → controller → service → repository → Mongoose model → MongoDB`.
- Route khai báo endpoint/middleware; controller điều phối HTTP; service giữ nghiệp vụ; repository đóng gói query; model mô tả persistence. Không query trực tiếp từ controller hoặc frontend.
- Tên module theo vai trò: `vehicle.controller.ts`, `vehicle.service.ts`, `vehicle.repository.ts`, `vehicle.model.ts` nếu dùng TypeScript; dùng extension hiện có nếu dự án dùng JavaScript.
- Middleware xử lý lỗi tập trung; kiểm tra Express version trước khi chọn async error wrapper. Tái sử dụng `AppError`/`ApiResponse` nếu đã có, không mặc định chúng tồn tại.
- Không trả stack trace, MongoDB URI, query hoặc document nội bộ. Ánh xạ DTO bằng allowlist; không chỉ xóa mỗi password hash.
- Validate body/path/query; allowlist trường được ghi, sort/filter và giới hạn phân trang. Không truyền nguyên `req.body`/`req.query` vào Mongoose filter/update.

## Mongoose và MongoDB

- Trước thay đổi model/schema, index, query, populate, aggregation, cấu hình kết nối, dependency DB hoặc test DB: xin phép theo tài liệu database.
- Đọc schema và dữ liệu mẫu đã được cho phép; không tự đổi tên collection, kiểu ObjectId/string, required/default hoặc quan hệ embed/reference.
- Validate ID đúng định dạng ở boundary; ID hợp lệ không có nghĩa bản ghi tồn tại hoặc caller có quyền.
- Dùng projection giới hạn dữ liệu. Dùng `lean()` cho truy vấn chỉ đọc không cần document methods; kiểm tra ảnh hưởng getters, virtuals và serialization trước khi đổi.
- Phân trang có thứ tự ổn định; hạn chế populate/aggregation nặng. Chỉ thêm index sau khi nêu query cần tối ưu và được duyệt.
- `unique` là ràng buộc index, không phải Mongoose validator; xử lý duplicate key thành lỗi nghiệp vụ phù hợp.
- Update phải bảo toàn validation và bất biến nghiệp vụ; xem xét `runValidators` theo API sử dụng, không coi nó thay thế kiểm tra nghiệp vụ hoặc concurrency.
- Các thay đổi tồn kho, đặt cọc, thanh toán và trạng thái xe cần cơ chế chống xử lý lặp/concurrent update phù hợp.
- Khi cần transaction, xác minh MongoDB deployment hỗ trợ transaction (replica set/sharded cluster phù hợp); không giả định standalone hỗ trợ. Giải thích và xin phép trước khi đổi hạ tầng/cấu hình.
- Không tự bật `autoIndex`, gọi `syncIndexes`, drop collection, seed hoặc migrate khi startup. Không dùng mock fallback khi DB lỗi.
- Quản lý kết nối dùng chung, đóng kết nối khi shutdown; không tạo kết nối mới cho mỗi request.

## Bảo mật và nghiệp vụ

- Backend là nguồn quyết định quyền. Kiểm tra authentication, role/action, ownership và phạm vi chi nhánh/gara nếu có.
- Không tin tổng tiền, giá, role, trạng thái do client gửi; tính và kiểm tra phía service theo quy tắc đã xác nhận.
- Không tự đặt enum trạng thái, quyền, thuế, cách làm tròn, chính sách hủy/bảo hành hay quy tắc uniqueness.
- CORS, cookie, CSRF và session/token theo thiết kế đã chốt; không sửa bảo mật để “frontend gọi được”.
- Config tập trung; không log secret/PII. Lỗi DB phải được báo có kiểm soát, không giả thành danh sách rỗng hoặc thành công.

## Kiểm tra và contract

- Đọc [api-contract-rules.md](api-contract-rules.md) trước khi thay đổi API.
- Test validation, 401/403, quyền từng bản ghi, duplicate key, không tìm thấy, xung đột trạng thái, gửi lặp và rollback/lỗi giữa chừng khi liên quan.
- Integration test phải kiểm tra đúng nhánh Mongoose với DB test cô lập đã duyệt, không âm thầm chạy mock store.
- Không chạy script hoặc test ghi DB trước khi được duyệt đúng môi trường và phạm vi.
