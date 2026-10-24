# Quy tắc database và phê duyệt

> Đọc cùng [mục lục và quy trình đọc bắt buộc](README.md).

## Nguyên tắc bắt buộc về database

**Nếu AI sửa bất kỳ thứ gì liên quan đến database thì phải hỏi người dùng trước, giải thích tại sao một cách ngắn gọn nhưng đủ chi tiết, và chỉ thực hiện sau khi người dùng đồng ý rõ ràng với phạm vi thay đổi.**

### Phạm vi phải xin phép

- Tạo mới, sửa hoặc xóa schema, model/entity, bảng/collection, cột/field, kiểu dữ liệu, quan hệ, constraint, index, enum được lưu trong DB hoặc giá trị mặc định.
- Tạo/sửa/chạy migration, seed, backfill, import/export, script sửa dữ liệu, reset hoặc xóa database.
- Tạo/sửa query, repository/DAO, ORM mapping, raw SQL, aggregation, transaction hoặc logic đọc/ghi dữ liệu, kể cả khi không đổi schema.
- Thay đổi kết nối, cấu hình DB, quyền truy cập, pooling, ORM/database dependency hoặc cấu hình tự đồng bộ schema/index.
- Thay đổi fixture, seed, setup hoặc cleanup của test có thao tác database.
- Chạy ứng dụng, script hay test có thể ghi DB, tự migrate, tự tạo index/schema hoặc xóa dữ liệu mà phạm vi đó chưa được phê duyệt.
- Quy tắc áp dụng cho DB local, development, test, staging và production. Yêu cầu làm một tính năng không mặc nhiên cho phép mọi thay đổi DB phục vụ tính năng đó.

### Cách xin phép

Trước khi sửa file liên quan hoặc thực thi, gửi một đề xuất ngắn gồm:

1. **Thay đổi:** file/thành phần, bảng/collection/field/query và môi trường bị tác động.
2. **Lý do:** vấn đề hiện tại, tại sao cần thay đổi, kết quả mong đợi.
3. **Ảnh hưởng:** dữ liệu cũ, tương thích API, hiệu năng, nguy cơ mất dữ liệu hoặc gián đoạn; nêu rõ phần chưa xác định.
4. **An toàn:** cách kiểm thử, backup/khôi phục nếu cần và phương án không đổi DB nếu khả thi.
5. **Xin phép:** hỏi rõ người dùng duyệt sửa code, chạy lệnh, hay cả hai.

Ví dụ:

> Đề xuất sửa query lấy danh sách xe trong repository để phân trang tại DB thay vì tải toàn bộ. Không đổi schema hay dữ liệu; thứ tự kết quả sẽ được giữ ổn định. Em sẽ bổ sung test trên DB test cô lập, không truy cập DB thật. Bạn có đồng ý cho sửa query và chạy các test này không?

### Giới hạn phê duyệt

- Chưa có câu trả lời rõ ràng: dừng phần DB; chỉ đọc source/tài liệu hoặc làm phần độc lập không liên quan DB.
- Được phép sửa migration không đồng nghĩa được phép chạy migration. Được phép trên test không đồng nghĩa được phép trên staging/production.
- Có thể xin phép một nhóm thay đổi liên quan trong một lần nếu liệt kê rõ phạm vi; không hỏi lại cho từng dòng đã được duyệt. Phát sinh ngoài phạm vi phải hỏi lại.
- Không tự chạy lệnh destructive, drop, truncate, reset, force sync, reseed hay sửa dữ liệu thật để chữa lỗi.
- Trước thao tác phá hủy: xác nhận đúng môi trường, phạm vi dữ liệu, bản backup và khả năng phục hồi; không hứa rollback nếu thao tác không thể đảo ngược.
- Không dùng subagent, công cụ khác, startup hook hoặc CI để lách yêu cầu xin phép.
- Đọc source/schema/tài liệu không sửa đổi không cần xin phép theo mục này. Truy cập dữ liệu thật, xuất dữ liệu hay xử lý thông tin cá nhân vẫn cần phạm vi được cho phép.
