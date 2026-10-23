# Quy tắc làm việc chung

> Đọc cùng [mục lục và quy trình đọc bắt buộc](README.md).

## Hiểu yêu cầu trước khi thực hiện

- Đọc `README.md`, tài liệu liên quan trong `docs/`, code gần nơi sửa và cấu hình chạy/test hiện có.
- Nếu tài liệu chưa có, nói rõ; không bịa kiến trúc, lệnh chạy, API hoặc kết quả kiểm thử.
- Xác nhận phạm vi “gara ô tô cũ”: sửa chữa/bảo dưỡng, kinh doanh xe đã qua sử dụng, hay kết hợp. Không tự triển khai cả hai khi chưa được yêu cầu.
- Stack đã xác nhận: Next.js/React cho frontend; Node.js/Express và Mongoose cho backend; MongoDB cho database. Không tự thay đổi stack này hoặc chốt thêm dịch vụ thanh toán, lưu trữ, mô hình phân quyền. Đưa khuyến nghị kèm lý do và xin xác nhận khi lựa chọn ảnh hưởng lớn.
- Với thay đổi nhiều module, trình bày phạm vi, cách làm và cách kiểm tra trước khi code. Với DB, luôn tuân thủ [database-rules.md](database-rules.md) dù thay đổi nhỏ.
- Chỉ hỏi những điều không thể xác định từ repository; không bắt người dùng trả lời thông tin đã có trong tài liệu.

## Thiết kế và chất lượng code

- Ưu tiên YAGNI, KISS, DRY: làm đúng nhu cầu hiện tại, đơn giản, tránh trùng lặp có ý nghĩa.
- Giữ thay đổi nhỏ, đúng phạm vi; không refactor cả dự án khi sửa một lỗi.
- Dùng ngôn ngữ, convention, thư viện và component đang có. Với dự án JavaScript mới, đề xuất TypeScript; không tự chuyển ngôn ngữ dự án đã có.
- Một module có trách nhiệm rõ ràng. File dài khoảng 200–300 dòng là dấu hiệu cần xem lại, không phải lý do tách máy móc.
- Tên biến/hàm mô tả nghiệp vụ; tránh `any` và ép kiểu để che lỗi nếu dùng TypeScript.
- Comment giải thích “tại sao”, không lặp lại code; không đưa mã kế hoạch/phase/finding vào code.
- Không dùng dữ liệu giả, kết quả hard-code hay bỏ validation để tạo cảm giác chức năng đã chạy.
- Không tự fallback sang mock store khi DB mất kết nối; trả lỗi có kiểm soát và log phù hợp.

## Quy ước đặt tên

Ưu tiên convention đã có. Với dự án mới chưa có convention:

| Thành phần | Quy ước | Ví dụ |
|---|---|---|
| Backend theo tầng | tên module + vai trò | `vehicle.service.ts`, `repair-order.repository.ts` |
| React component nếu dùng React | PascalCase | `VehicleCard.tsx`, `RepairOrderForm.tsx` |
| Helper, hook, tài liệu | kebab-case | `format-currency.ts`, `use-vehicles.ts`, `business-rules.md` |
| Biến/hàm | camelCase | `calculateRepairTotal` |
| Class/type/interface | PascalCase | `Vehicle`, `RepairOrder` |
| Hằng | UPPER_SNAKE_CASE | `MAX_UPLOAD_SIZE` |

- Route/file đặc biệt theo convention của framework đã chọn.
- Quy ước tên DB chỉ được chốt hoặc thay đổi theo [database-rules.md](database-rules.md).

## Tài liệu và quản lý thay đổi

Danh sách sau là nơi bổ sung tài liệu ứng dụng khi triển khai, không phải khẳng định tất cả file đã có trong bộ mẫu. Hiện tại `business-rules.md` chứa checklist cần xác nhận; `testing-guide.md` chứa quy tắc kiểm thử, chưa có lệnh chạy ứng dụng cụ thể.

- `README.md`: giới thiệu, yêu cầu môi trường, cách chạy và liên kết tài liệu.
- `docs/setup-guide.md`: thiết lập, biến môi trường mẫu, lệnh thực tế.
- `docs/system-architecture.md`: kiến trúc, module, tích hợp và quyết định kỹ thuật đã chốt.
- `docs/business-rules.md`: nghiệp vụ đã xác nhận, trạng thái, phân quyền, quy tắc tính tiền.
- `docs/be/api-reference.md`: endpoint, auth, request/response, lỗi và phân trang.
- `docs/fe/frontend-logic.md`: luồng giao diện và tích hợp API khi cần.
- `docs/testing-guide.md`: cách chạy test và cách cô lập môi trường.
- Chỉ tạo/cập nhật tài liệu liên quan khi có nội dung thực; không tạo file rỗng để đủ cấu trúc. Phân biệt rõ “đề xuất” với “đã triển khai”.
- Tác vụ lớn lưu kế hoạch ở `plans/<timestamp>-<descriptive-slug>/plan.md`; không đưa dữ liệu nhạy cảm vào kế hoạch.
- Giữ public contract tương thích; thay đổi breaking phải nêu ảnh hưởng và được duyệt trước.

## Git và bàn giao

- Không tự commit, push, mở PR, merge hoặc deploy khi chưa được yêu cầu.
- Commit theo Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`; thông điệp tập trung vào thay đổi, không thêm tham chiếu AI.
- Không ghi đè thay đổi đang có của người dùng; không dùng reset/clean/force push để giải quyết lỗi mà chưa được đồng ý.
- Trước bàn giao: tự review diff, kiểm tra secret, phạm vi thay đổi, quyền truy cập, contract và test.
- Báo cáo ngắn: đã thay đổi gì, vì sao, kiểm tra nào đã chạy, lỗi/chưa kiểm tra và điều cần người dùng quyết định.

### Checklist bàn giao

- [ ] Đúng yêu cầu, không thêm nghiệp vụ hoặc dependency ngoài phạm vi.
- [ ] Mọi thay đổi liên quan DB đã được giải thích và phê duyệt đúng phạm vi; việc chạy lệnh được duyệt riêng nếu cần.
- [ ] Không có migration/seed/reset tự chạy ngoài phạm vi cho phép.
- [ ] API, validation, phân quyền và dữ liệu nhạy cảm đã được kiểm tra.
- [ ] UI có trạng thái và thông báo phù hợp nếu có thay đổi frontend.
- [ ] Test/lint/typecheck/build liên quan đã chạy hoặc ghi rõ lý do chưa chạy.
- [ ] Tài liệu/contract bị ảnh hưởng được cập nhật; không bịa kết quả.
- [ ] Không commit secret hoặc sửa/xóa dữ liệu thật ngoài phê duyệt.
