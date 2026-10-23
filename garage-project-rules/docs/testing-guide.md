# Kiểm thử và xác minh

> Đọc cùng [mục lục và quy trình đọc bắt buộc](README.md).

## Kiểm thử và xác minh

- Đọc source và yêu cầu trước khi viết test. Test phải kiểm tra hành vi thực, không tạo assertion vô nghĩa hoặc nới điều kiện để pass.
- Chạy test hẹp nhất liên quan trước, sau đó lint/typecheck/build và các test rộng hơn nếu chạm contract hoặc module dùng chung.
- Chỉ dùng lệnh/script thực sự có trong dự án. Nếu thiếu tooling, nói rõ và đề xuất trước khi cài mới.
- Test DB phải tuân thủ [database-rules.md](database-rules.md) và chạy trên môi trường test cô lập đã duyệt; không dùng DB dev chung/staging/production để seed, reset hoặc cleanup.
- Kiểm tra đích kết nối trước khi chạy test có ghi DB; không để test âm thầm chạy mock thay vì persistence thật khi mục tiêu là integration test.
- Mock dịch vụ ngoài tại ranh giới test khi phù hợp; không gửi email/SMS thật hay tạo giao dịch thanh toán thật trong test tự động.
- Bao phủ luồng thành công, input sai, không đăng nhập, sai quyền, không tìm thấy, xung đột trạng thái và truy cập bản ghi của người khác.
- Với chức năng có tồn kho/thu tiền/đặt cọc/bán xe: kiểm tra gửi lặp, cạnh tranh đồng thời và lỗi giữa chừng theo thiết kế được duyệt.
- Test UI ưu tiên role/label và hành vi người dùng, không bám chặt class CSS. Ngày giờ, locale và dữ liệu test phải xác định, độc lập.
- Không tự bỏ test, bỏ lint hoặc sửa kỳ vọng để che bug. Báo rõ lệnh đã chạy, kết quả và phần chưa kiểm chứng; không nói “đã pass” nếu chưa chạy.
