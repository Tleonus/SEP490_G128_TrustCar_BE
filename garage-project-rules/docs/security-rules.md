# Bảo mật và dữ liệu cá nhân

> Đọc cùng [mục lục và quy trình đọc bắt buộc](README.md).

## Bảo mật và dữ liệu cá nhân

- Route nhạy cảm phải kiểm tra đăng nhập, quyền theo hành động và quyền trên bản ghi; nếu có nhiều gara/chi nhánh, kiểm tra cả phạm vi được truy cập.
- Không tự đặt tên role hay cấp quyền quản trị qua đăng ký công khai. Thiết lập tài khoản quản trị đầu tiên phải có quy trình được duyệt.
- Mật khẩu phải hash bằng thư viện phù hợp; không lưu plaintext hoặc trả password hash, token nội bộ cho client.
- Không commit `.env`, khóa riêng, credential, dữ liệu khách hàng hoặc bản dump. File cấu hình mẫu chỉ chứa placeholder an toàn.
- Không log đầy đủ token, số điện thoại, địa chỉ, giấy tờ xe/khách hàng; chỉ ghi thông tin cần thiết và che dữ liệu nhạy cảm.
- Dùng query có tham số/ORM đúng cách; allowlist trường cập nhật để tránh mass assignment, kiểm soát XSS và upload file.
- Nếu dùng cookie auth: cấu hình HttpOnly, Secure, SameSite và bảo vệ CSRF phù hợp. CORS theo origin được duyệt, không mở tùy tiện.
- Nếu tích hợp thanh toán: xác minh chữ ký webhook và đối chiếu giao dịch phía server; không coi trang redirect thành công là bằng chứng đã thanh toán.
- Đọc cấu hình qua một module thống nhất; không đưa secret backend vào bundle frontend.
