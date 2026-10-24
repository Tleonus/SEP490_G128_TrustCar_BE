# Hướng dẫn dùng chung cho AI coding agents

Áp dụng cho toàn bộ dự án. Nguồn quy tắc chuẩn nằm trong `docs/`, không phụ thuộc nhà cung cấp AI.

**Bắt buộc trước mỗi tác vụ:** đọc `README.md` và [docs/README.md](docs/README.md), sau đó đọc đủ tài liệu chung và tài liệu frontend/backend theo bảng hướng dẫn trong đó. Không sửa code trước khi đọc docs liên quan. Khi phiên làm việc mất context hoặc tài liệu thay đổi, đọc lại phần cần thiết.

- Stack: Next.js/React frontend; Node.js/Express backend; Mongoose ODM; MongoDB.
- Frontend: [docs/frontend-rules.md](docs/frontend-rules.md).
- Backend: [docs/backend-rules.md](docs/backend-rules.md).
- Tích hợp: [docs/api-contract-rules.md](docs/api-contract-rules.md).
- **Nếu AI sửa bất kỳ thứ gì liên quan đến database thì phải hỏi người dùng trước, giải thích tại sao ngắn gọn nhưng đủ chi tiết, và chờ đồng ý rõ ràng trước khi sửa hoặc chạy.** Đọc đầy đủ [docs/database-rules.md](docs/database-rules.md), kể cả khi chỉ đổi query, test hoặc cấu hình.
- Nêu tài liệu đã đọc, phạm vi thay đổi và ảnh hưởng DB trước khi làm; báo kết quả kiểm thử trung thực sau khi làm.
- Nếu không đọc được docs, báo và yêu cầu nội dung; không đoán hoặc bỏ qua.
