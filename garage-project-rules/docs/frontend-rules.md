# Frontend — Next.js và React

## Bắt buộc trước khi sửa

Đọc [docs/README.md](README.md), các tài liệu chung được chỉ định và file này. Nếu thay đổi liên quan DB, kể cả từ Server Action/Route Handler, phải xin phép theo [database-rules.md](database-rules.md). Không truy cập MongoDB trực tiếp từ frontend.

## Kiến trúc

- Next.js là framework frontend sử dụng React; backend nghiệp vụ là Node.js/Express riêng, truy cập MongoDB qua Mongoose.
- Đọc phiên bản Next.js và cấu trúc router thực tế trước khi dùng API. Không tự chuyển Pages Router sang App Router hoặc nâng phiên bản.
- Với App Router: ưu tiên Server Component; chỉ dùng `use client` khi cần state, hook, sự kiện hoặc browser API. Giữ client boundary nhỏ.
- Route Handler/Server Action, nếu có, chỉ đóng vai trò tích hợp/BFF theo kiến trúc đã chốt; không nhân đôi nghiệp vụ, phân quyền hoặc persistence của Express.
- Dùng API client chung. Tách rõ client phía server và browser; không rải URL backend hoặc logic refresh token trong từng component.
- Server-side request phải chuyển thông tin xác thực cần thiết theo thiết kế; không giả định cookie của trình duyệt tự được gửi từ server Next.js sang Express.
- Chỉ truyền DTO có thể serialize vào Client Component; không truyền Mongoose document, secret hoặc thông tin nội bộ.

## Dữ liệu và trạng thái

- Mỗi màn hình có loading, empty, error, success state; không dùng dữ liệu giả để che API lỗi.
- Dữ liệu khách hàng, công nợ, hóa đơn và phân quyền không được cache công khai hoặc chia sẻ giữa các user. Chọn cache/revalidation rõ ràng theo phiên bản Next.js và loại dữ liệu, không dựa vào mặc định chưa kiểm tra.
- Sau mutation cập nhật hoặc invalidate dữ liệu liên quan; không chỉ đổi UI rồi coi như server đã thành công.
- Dùng helper thống nhất cho tiền, ngày, trạng thái; tránh hydration mismatch do thời gian, locale hoặc browser API.
- Giữ filter, sort và pagination nhất quán với API contract; server chịu trách nhiệm phân trang dữ liệu lớn.

## UI và form

- Tái sử dụng component và design token. Không tự cài bộ UI/state management mới nếu chưa cần.
- Component PascalCase; helper/hook kebab-case; file route theo Next.js. Nếu dùng TypeScript, tránh `any` và ép kiểu để che lỗi contract.
- Form có label, validation, lỗi tại field, trạng thái gửi và ngăn submit lặp. Backend vẫn validate lại.
- Xóa/hủy/chốt chứng từ/bàn giao cần xác nhận và giải thích hậu quả; thao tác tài chính không dùng optimistic update thiếu phương án xử lý lỗi.
- Phân quyền UI phục vụ trải nghiệm, không thay thế quyền ở Express.
- Responsive; thao tác được bằng bàn phím; focus rõ; màu không phải dấu hiệu trạng thái duy nhất. Thông báo tiếng Việt nhất quán.
- Không đưa secret hoặc URI MongoDB vào biến `NEXT_PUBLIC_*`, bundle, HTML hoặc log client.

## Kiểm tra và bàn giao

- Test component theo role/label và hành vi người dùng; test loading/error, input sai, gửi lặp, sai quyền và lỗi API.
- Test tích hợp luồng đăng nhập/cookie, chuyển trang, mutation và cập nhật dữ liệu theo tooling đã có.
- Chạy script lint/typecheck/build/test thực sự có; build có thể thực thi fetch nên kiểm tra side effect trước.
- Thay đổi API: đọc [api-contract-rules.md](api-contract-rules.md), phối hợp backend và cập nhật contract thực tế; không tự bịa endpoint.
