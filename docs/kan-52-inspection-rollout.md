# Rollout kiểm định KAN-52

T021 chuẩn bị định nghĩa mẫu, bản xem trước chuyển đổi nháp và quy trình triển khai. T023 đã nối quyền và router mới trong mã. Người vận hành cần checkpoint C5 cho môi trường đích, bản sao lưu, truy vấn và thao tác ghi trước khi chạy rollout.

## Chuẩn bị trước khi mở luồng

1. Chốt môi trường, người thực hiện, cửa sổ triển khai và phương án khôi phục. Tạm khóa các tuyến kiểm định nội bộ tại điểm vào hệ thống và dừng hoặc rút tất cả instance cũ. Bước này tránh việc instance cũ tiếp tục phục vụ quyền ghi hoặc đồng bộ lại bảng quyền cũ.
2. Sao lưu dữ liệu liên quan và xác minh khả năng khôi phục. Phạm vi gồm `inspectionrecords`, dữ liệu xe liên quan, Role mặc định, phiên bản và con trỏ mẫu, và dữ liệu audit. Ghi nhận chỉ mục đang dùng cùng bản mã trước triển khai.
3. Cung cấp nội dung ELECTRIC được người phụ trách kiểm định duyệt. Dùng `createElectricInitialForm(groups)` để chuẩn hóa năm nhóm cố định và kiểm cấu hình câu hỏi. Mẫu GASOLINE dùng `createGasolineInitialForm()`, với toàn bộ hạng mục checklist xăng 1.0 và đáp án tương ứng. Fixture xe điện chỉ phục vụ kiểm thử.
4. Xác minh MongoDB đích hỗ trợ các giao dịch nhiều tài liệu và hỗ trợ `$in` trong biểu thức lọc của partial index tại phiên bản và cấu hình đang dùng. Đối chiếu `openInspectionIndex` trong `src/models/InspectionRecord.js` với tài liệu [MongoDB Transactions](https://www.mongodb.com/docs/manual/core/transactions/) và [Partial Indexes](https://www.mongodb.com/docs/manual/core/index-partial/).
5. Xuất dữ liệu cho dry run. Phải có đủ hồ sơ ở cả `DRAFT` và `PENDING_APPROVAL`, xe liên quan, và các mẫu hiện hành theo con trỏ. Giữ kiểu Date của `updatedAt` và các trường định danh. Kiểm hồ sơ mở không có xe hoặc `carId` hợp lệ, cũng như revision mẫu được tham chiếu từ nháp đã gán.

## Mẫu ban đầu

Mỗi định nghĩa phiên bản đầu gồm `templateKey`, `revision: 1`, `groups` và `retiredIds`. Khi seed theo C5, ghi đồng thời phiên bản bất biến, con trỏ hiện hành và nhật ký khởi tạo có người thực hiện. Cặp head và revision hiện hữu phải nhất quán. Với mẫu đã có, giữ con trỏ và phiên bản hiện hành. Nếu chỉ có một phía hoặc con trỏ trỏ tới dữ liệu thiếu, dừng và đối soát trước.

Tên bảng và schema seed lấy theo các model tại `src/infra/inspection/formTemplateModel.js`. Khi duyệt lệnh đích, ghi rõ cách ghi audit cho lần đầu và giá trị `previousRevision` đại diện cho phiên bản chưa tồn tại. Tuyến cập nhật mẫu dành cho phiên bản đã có và đối chiếu với head hiện hành.

## Xem trước nâng cấp nháp

Hàm `previewInspectionDraftUpgrade({ records, cars, templates })` lập kế hoạch trong bộ nhớ. `templates` chứa đúng một phiên bản hiện hành cho mỗi mẫu. Dùng dữ liệu dự kiến seed cho mẫu còn thiếu trong lần diễn tập đầu, rồi chạy lại với dữ liệu đã xác nhận trên database đích trước khi áp dụng.

| Kết quả | Cách xử lý |
| --- | --- |
| `READY` | Rà danh sách thay đổi và mốc `expected`. Chỉ áp dụng theo lệnh C5 đã duyệt. |
| `SKIPPED` | Hồ sơ không phải nháp hoặc đã gán mẫu hợp lệ. Đối chiếu nguồn revision nếu hồ sơ đã gán mẫu. |
| `BLOCKED` | Xác minh nguyên nhân theo `code`. Giữ nguyên dữ liệu và lập phương án cho từng hồ sơ chưa xử lý được. |
| `duplicates` | Kiểm từng xe có nhiều hồ sơ mở. Chốt cách xử lý với người phụ trách trước khi cài chỉ mục duy nhất. |

Khi áp dụng một hàng `READY`, so khớp lại `_id`, `carId`, `status`, `templateKey`, `checklistVersion` và `updatedAt` trên hồ sơ. Đối chiếu lại loại nhiên liệu và revision mẫu hiện hành từ `expected` trong cùng giao dịch. Nếu trạng thái đã đổi hoặc điều kiện không còn khớp, bỏ qua hàng đó và lập lại dry run. Chỉ ghi các trường trong `changes` cùng mốc cập nhật và audit phù hợp. Lưu bằng chứng trước/sau theo quyền của đợt vận hành. Báo cáo chia sẻ dùng số lượng và mã kết quả.

Với nháp xăng 1.0, ID câu hỏi là `<groupKey>.<itemKey>`. Kết quả cũ chuyển sang câu trả lời khi ID và nghĩa của lựa chọn vẫn khớp. Câu từng ánh xạ qua phiên bản mẫu 1 được lưu riêng với `sourceRevision: 1` nếu mẫu hiện hành bỏ câu hoặc đổi cách chấm. Câu trả lời chưa gắn revision được lưu riêng với `sourceRevision: null`. Nội dung hạng mục, ảnh và ghi chú gốc vẫn nằm trong hồ sơ. Hạng mục có kết quả mơ hồ hoặc câu chấm mẫu điện cần nhân viên kiểm tra và điền lại.

## Áp dụng và xác minh

1. Sau mốc C5, thực hiện seed và cập nhật nháp theo phiên bản và kế hoạch đã kiểm. Xác minh dữ liệu biên bản lịch sử và snapshot đã khóa sau từng đợt.
2. Đối chiếu định nghĩa `uniq_open_inspection_per_car` trên `carId`. Điều kiện lọc bao gồm `DRAFT` và `PENDING_APPROVAL`. Kiểm dữ liệu trùng và khả năng cài song song với `uniq_draft_per_car` trên bản MongoDB đích trước khi chọn trình tự thay chỉ mục. Giữ chỉ mục cũ cho tới khi phương án đích đã được kiểm. Kiểm cả chỉ mục mã CPO và hash xác minh bằng các fixture có và thiếu chứng nhận trong môi trường thử nghiệm tương đương.
3. Khởi động phiên bản mới khi luồng vẫn được khóa. `src/server.js` gọi `Role.seedDefaultRoles()` trước khi mở listener. Xác minh quyền từ Role đã lưu và quyền dự phòng với các tài khoản kiểm thử.
4. Dùng tài khoản SALES_STAFF để kiểm xem/nộp được và tạo, sửa, ký ảnh, kiểm định nhanh đều nhận 403. Kiểm tài khoản kiêm INSPECTOR có quyền ghi. Kiểm ADMIN khác người nộp có thể duyệt và ADMIN tự duyệt nhận 403. Gửi payload nộp có trường dư phải nhận 422 và giữ nguyên nháp.
5. Xác minh tạo nháp cho cả hai mẫu, thao tác trên nháp đã chuyển đổi, lưu phiên bản mới của một mẫu, kiểm định nhanh bị chặn khi có hồ sơ mở, và dữ liệu năm tiêu chí trên biên bản đã duyệt. Đối chiếu KAN-15 với xe có chứng nhận hợp lệ và dữ liệu lịch sử. Chỉ mở lưu lượng sau khi người phụ trách xác nhận các kiểm tra đạt.

## Hoàn tác

1. Khóa luồng và dừng bản mới trước khi quay lại bản trước. Giữ lại backup, nhật ký, các phiên bản mẫu và danh sách hồ sơ bị tác động.
2. Nếu luồng mới chưa mở, đối chiếu bản sao trước thay đổi rồi hoàn tác các hàng trong kế hoạch theo điều kiện ghi đã được duyệt. Nếu đã có lượt ghi mới, xử lý hồ sơ `PENDING_APPROVAL`, phiên bản mẫu và câu trả lời mới theo phương án giữ dữ liệu do người phụ trách duyệt. Kiểm tác động tới chứng nhận và báo cáo trước khi phục hồi.
3. Xác nhận lại quyền hiệu lực và chỉ mục trước khi mở luồng. Bản cũ có thể tự đồng bộ quyền ghi cũ khi khởi động. Giữ luồng kiểm định bị khóa cho đến khi quyền ghi, nộp và xử lý hồ sơ chờ duyệt phù hợp với quyết định rollback đã được duyệt.
