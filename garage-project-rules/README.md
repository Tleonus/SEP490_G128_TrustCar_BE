# Bộ rule AI dùng chung — Web quản lý gara ô tô cũ

Bộ tài liệu độc lập với nhà cung cấp AI, tham khảo convention/code standards/testing guide trong `example.zip`. Không phải source ứng dụng; không có dependency, endpoint hoặc schema được triển khai bởi bộ rule này.

**Stack đã xác nhận:** Next.js/React frontend, Node.js/Express backend, Mongoose ODM và MongoDB.

## Cấu trúc

```text
AGENTS.md                         # Điểm vào chung cho coding agents
CLAUDE.md                         # Nhắc Claude đọc docs
GEMINI.md                         # Nhắc Gemini đọc docs
.github/copilot-instructions.md   # Nhắc Copilot đọc docs
.cursor/rules/project-docs.mdc    # Nhắc Cursor đọc docs, alwaysApply
README.md                         # Hướng dẫn sử dụng
 docs/
  README.md                       # Thứ tự đọc bắt buộc, stack, nguồn chuẩn
  common-rules.md                 # Quy trình, chất lượng code, naming, Git
  frontend-rules.md               # Next.js/React
  backend-rules.md                # Express/Mongoose/MongoDB
  api-contract-rules.md           # Giao tiếp frontend/backend
  database-rules.md               # Xin phép trước mọi thay đổi DB
  business-rules.md               # Ràng buộc nghiệp vụ, phạm vi cần chốt
  security-rules.md               # Quyền truy cập, secret, dữ liệu cá nhân
  testing-guide.md                # Kiểm thử và xác minh
```

## Cài vào dự án

1. Sao chép **nội dung** thư mục này vào gốc dự án mới, gồm cả `.github/` và `.cursor/` nếu dùng các công cụ tương ứng. Không sao chép nguyên thư mục lồng rồi kỳ vọng công cụ tự nhận rule.
2. Nếu dự án đã có README, AGENTS, CLAUDE, docs hoặc cấu hình AI, đọc và hợp nhất thủ công; không ghi đè hướng dẫn/code hiện có. README này là hướng dẫn bộ mẫu, không thay thế README ứng dụng đã có.
3. Mở AI tại gốc repository và yêu cầu đọc `AGENTS.md` cùng `docs/README.md`. Kiểm tra trong phiên đầu AI thực sự đọc file, không chỉ nói đã đọc.
4. Nếu frontend/backend ở hai repository riêng, đặt bộ docs và điểm vào tại gốc mỗi repo, giữ phần stack/contract/database thống nhất; không trỏ tới đường dẫn ngoài repo mà AI không đọc được. Nếu cùng repo, dùng một bộ docs chung và chọn file theo phạm vi.
5. Khi quy tắc đổi, sửa tài liệu chuẩn trong `docs/`, không tạo nhiều bản nội dung khác nhau trong các adapter.

### Công cụ và khả năng tự nạp

| Công cụ | Điểm vào |
|---|---|
| Coding agent hỗ trợ AGENTS.md (ví dụ Codex) | `AGENTS.md` |
| Claude Code | `CLAUDE.md` |
| Gemini CLI có hỗ trợ project context tương ứng | `GEMINI.md` |
| GitHub Copilot có bật repository instructions | `.github/copilot-instructions.md` |
| Cursor có hỗ trợ project rules | `.cursor/rules/project-docs.mdc` |
| AI/chat khác | Gửi prompt bên dưới và đính kèm docs hoặc cấp quyền đọc repo |

Khả năng tự nạp phụ thuộc phiên bản, chế độ và cài đặt công cụ. Các file là chỉ dẫn, **không phải cơ chế khóa quyền thực thi**. Muốn chặn thao tác DB thực sự, cần cấu hình quyền công cụ và credential theo môi trường; bộ này không tự thiết lập những quyền đó.

## Prompt mở đầu cho AI bất kỳ

> Trước khi làm việc, hãy đọc README.md, AGENTS.md và docs/README.md tại gốc dự án. Sau đó đọc đầy đủ các docs chung và docs frontend/backend/API theo phạm vi công việc. Hãy nêu ngắn gọn các file đã đọc và quy tắc sẽ áp dụng. Nếu không đọc được, báo rõ và yêu cầu tôi cung cấp nội dung; không đoán. Stack là Next.js/React, Node.js/Express, Mongoose và MongoDB. Nếu định sửa bất kỳ thứ gì liên quan database, kể cả query/model/test/config, hãy dừng, giải thích thay đổi, lý do, ảnh hưởng và cách kiểm tra/khôi phục ngắn gọn nhưng đủ chi tiết; chỉ thực hiện sau khi tôi đồng ý rõ ràng. Quyền sửa code không mặc nhiên cho phép chạy migration/seed hoặc lệnh ghi DB.

## Phạm vi chưa chốt

Tài liệu nghiệp vụ chỉ là ràng buộc và checklist: chưa mặc định gara chỉ sửa chữa hay có kinh doanh xe cũ. Chưa tự chốt role, state machine, thuế, bảo hành, phiên bản thư viện hoặc schema. AI phải đọc yêu cầu dự án thật trước khi triển khai.

Bắt đầu từ [docs/README.md](docs/README.md).
