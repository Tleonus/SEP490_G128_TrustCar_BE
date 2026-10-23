# Quy tắc contract frontend/backend

Đọc [mục lục](README.md) trước khi thay đổi. File này là quy tắc thiết kế contract, **không phải danh sách endpoint đã triển khai**.

- Frontend Next.js/React gọi backend Express. MongoDB/Mongoose nằm phía backend, không xuất trực tiếp document nội bộ sang UI.
- Trước triển khai, đọc contract thực tế nếu có; nếu thiếu, đề xuất contract và xác nhận các quyết định nghiệp vụ chưa rõ.
- Với mỗi endpoint ghi rõ: method/path, authentication/quyền, path/query/body, validation, success/error response, status code, phân trang và side effect.
- Thống nhất tên field, kiểu ID, biểu diễn tiền, thời gian/timezone, enum trạng thái, null/optional và metadata phân trang. Không tự đổi contract đang được sử dụng.
- Chỉ trả DTO allowlist; không trả password hash, token nội bộ, giấy tờ hoặc dữ liệu cá nhân ngoài quyền caller.
- Lỗi phải có thông điệp dễ hiểu và mã ổn định để frontend xử lý; không ràng buộc UI vào nội dung lỗi từ MongoDB.
- Liệt kê rõ chiến lược xác thực, cookie/header, CSRF, CORS và cách server-side Next.js chuyển thông tin xác thực tới Express.
- API ghi phải kiểm tra quyền và trạng thái ở server. Nếu cần idempotency/concurrency, định nghĩa hành vi retry và xung đột trước khi triển khai.
- Thay đổi breaking cần nêu consumer bị ảnh hưởng và kế hoạch chuyển đổi, xin xác nhận trước.
- Thay đổi API kéo theo query/model/logic ghi DB vẫn phải xin phép theo [database-rules.md](database-rules.md).
- Kiểm thử hai phía với cùng contract. Mock trong test phải phản ánh response thật; không sửa mock để giấu lệch API.
- Cập nhật tài liệu endpoint thực tế cùng thay đổi code; không đánh dấu endpoint dự kiến là đã hoạt động.
