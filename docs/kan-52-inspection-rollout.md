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

## Chuyển một mẫu sang tiêu chí tổng quát

### Xử lý dữ liệu đã lưu trước khi đổi mẫu

Đổi backend hoặc công bố mẫu mới chỉ thay cách xử lý các lần kiểm định tiếp theo. Các tài liệu cũ trong MongoDB giữ nguyên nội dung. Chọn phương án theo mục đích của database.

| Dữ liệu hiện có | Xử lý trên database có lịch sử sử dụng |
| --- | --- |
| Phiếu đã chốt, kể cả bản ghi lịch sử thiếu `status` | Giữ phiếu, ảnh, snapshot và revision gốc. Đối chiếu chứng nhận hiện hành bằng cặp `cars._id + cars.cpoCertificateId` với phiếu đạt đã chốt. Giữ mã và hash xác minh cho đến khi một lượt tái kiểm định mới được duyệt đạt. |
| Phiếu đang chờ duyệt | Duyệt hoặc trả về sửa theo mẫu đã nộp. Nếu cần đánh giá tiêu chí mới, mở một lượt kiểm định riêng sau khi xử lý xong phiếu đang mở và xe đủ điều kiện. |
| Nháp bảng câu hỏi đã gắn revision | Đối chiếu revision đó thực sự tồn tại và đúng loại nhiên liệu. Nháp có thể hoàn tất theo mẫu cũ sau khi công bố mẫu tiêu chí phẳng. |
| Nháp cũ thiếu mẫu, phiếu thiếu xe hoặc xe có nhiều phiếu mở | Đưa vào danh sách đối soát. `previewInspectionDraftUpgrade` hiện lập kế hoạch nâng nháp cũ sang **mẫu bảng câu hỏi**. Mẫu `CRITERIA` và các dòng `inspection_results` cần luồng chấm tương ứng. |
| Xe đang giữ chỗ, đã bán hoặc có mã CPO thiếu phiếu cấp | Giữ trạng thái kinh doanh và các liên kết hiện có, xác minh từng trường hợp. Chỉ nhánh tái kiểm định trên xe đang hoạt động, có mã, ở `APPROVED_CPO` hoặc `AVAILABLE` mới được dùng quy trình cấp lại hiện hành. |

**Bước kiểm kê chỉ đọc.** Trên đúng database đã xác nhận, truy vấn dưới đây cho biết số phiếu theo trạng thái, loại mẫu và phiên bản đã ghi. Nhãn `(thiếu)` giúp phát hiện hồ sơ cần đối chiếu. Hai mẫu cùng số revision có thể khác định dạng, cần tra `format` theo cả `templateKey` và `revision`. Truy vấn trả số lượng, không xuất nội dung phiếu.

```javascript
db.getCollection("inspectionrecords").aggregate([
  {
    $group: {
      _id: {
        status: { $ifNull: ["$status", "(thiếu)"] },
        templateKey: { $ifNull: ["$templateKey", "(thiếu)"] },
        checklistVersion: { $ifNull: ["$checklistVersion", "(thiếu)"] }
      },
      count: { $sum: 1 }
    }
  },
  { $sort: { "_id.templateKey": 1, "_id.checklistVersion": 1, "_id.status": 1 } }
])
```

Trước khi áp dụng, đối chiếu thêm con trỏ mẫu với các revision thực có, các xe có hơn một phiếu mở, các mã chứng nhận không tìm thấy phiếu cấp, các phiếu thiếu xe và các dòng kết quả thiếu phiếu. Sao lưu và thử khôi phục trước khi ghi. Script `cpoCertificateBackfill.js` tạo chứng nhận lịch sử với năm cờ đạt cho xe đủ điều kiện của script. Việc chuyển sang mẫu mới cần dựa vào kết quả chấm thực tế của từng tiêu chí.

**Nếu mục đích là demo từ đầu**, dùng một database riêng, kiểm tra tên đích, chuẩn bị collection và chỉ mục, khởi tạo revision đầu cùng head cho loại nhiên liệu có nội dung đã duyệt. API đề xuất cần có revision cơ sở. Tạo tài khoản và xe thử, dùng API để có một phiếu nháp, một phiếu chờ duyệt và một xe được cấp CPO. Với kịch bản v1 → v2, duyệt v2 khi xe vẫn giữ chứng nhận v1, rồi chấm và duyệt lại xe để kiểm chứng thời điểm đổi chứng nhận. Cách này giữ nguyên kho xe, đặt cọc và lịch sử đang dùng ở database hiện tại.

### Làm sạch CPO ngay trên database hiện tại

1. Ghi tên database và môi trường. Khi kiểm kê, so khớp tên đích được chỉ định với tên database của kết nối trước truy vấn đầu tiên. Ghi số lượng theo trạng thái phiếu, phiên bản mẫu, số xe có mã CPO, số xe có hash QR và số phiếu thiếu xe.
2. Chốt danh sách phiếu dự kiến dọn. Với mỗi xe liên quan, đối chiếu mã chứng nhận hiện hành, các phiếu khác của chính xe và trạng thái kinh doanh. Kiểm các tham chiếu từ `appointments.car`, `deposits.carId` và `sale_records.carId`. Thống kê riêng số xe có ít nhất một liên kết để tránh đếm trùng.
3. Trình số lượng sẽ thay đổi và tác động đến báo cáo/QR cho người phụ trách trước khi ghi. Mặc định bảo toàn phiếu cấp chứng nhận đang sử dụng, mẫu lịch sử được tham chiếu và nhật ký. Việc thu hồi chứng nhận cần quyết định cụ thể cho các xe bị ảnh hưởng.
4. Sau khi có bản sao đã kiểm tra khả năng khôi phục, áp dụng trên các ID đã duyệt. Trước mỗi lần ghi, kiểm lại trạng thái phiếu, xe và mã chứng nhận. Nếu dữ liệu đã đổi từ lúc kiểm kê, dừng xử lý bản ghi đó để đối soát. Cùng một lần dọn phải xử lý nhất quán phiếu và các dòng kết quả liên quan.
5. Đối chiếu số lượng trước/sau, xác minh báo cáo và QR của các xe giữ chứng nhận, kiểm phiếu mở, mẫu hiện hành và dữ liệu lịch hẹn/đặt cọc. Thử mở phiếu theo mẫu mới trên một xe đủ điều kiện sau khi hệ thống đã sẵn sàng.

### Công bố và xác minh

Triển khai bản đọc được cả hai định dạng trước khi phát hành revision `CRITERIA` đầu tiên. Với mỗi loại nhiên liệu, đối chiếu head, revision cơ sở và các phiếu đang mở. Mẫu cần có revision cơ sở để nhân viên lập đề xuất. Việc khởi tạo mẫu điện sử dụng nội dung do showroom duyệt.

| Thao tác trên môi trường đã có checkpoint C5 | Dấu hiệu đạt |
| --- | --- |
| Chuẩn bị hai collection `inspection_form_template_proposals` và `inspection_results`. Kiểm chỉ mục unique trên `(inspectionId, criterionId)` và unique có điều kiện trên `publishedRevisionId` kiểu ObjectId. | Chỉ mục thực tế khớp schema. Hai model có `autoCreate: false` và `autoIndex: false`. |
| Kiểm tra giao dịch nhiều tài liệu, chỉ mục duy nhất của head, cặp revision và phiếu mở theo xe. Kiểm bản sao lưu gồm cả hai collection mới và `activity_logs`. | Có thể phục hồi đúng head, đề xuất, các dòng chấm, phiếu và mã CPO tương ứng. |
| Nhân viên mở mẫu hiện hành, soạn danh sách tiêu chí rồi gửi. Admin trả về để sửa hoặc duyệt trong hàng chờ. | Trước khi duyệt, head và chứng nhận hiện hành giữ phiên bản cũ. Sau duyệt, mẫu mới có đúng tiêu chí và một sự kiện `INSPECTION_TEMPLATE_PUBLISHED`. |
| Mở phiếu mới và tái kiểm định một xe đã có CPO bằng các tài khoản kiểm thử. Đối chiếu báo cáo công khai với revision đã cấp. | Duyệt phiếu tái kiểm định đạt mới thay chứng nhận. Các tiêu chí và ảnh nội bộ được xử lý theo hợp đồng báo cáo của KAN-15. |

Nếu cần ngưng phát hành, khóa các tuyến ghi liên quan và tiếp tục phục vụ bằng bản đọc hỗ trợ cả hai định dạng. Dùng quy trình công bố revision tiếp theo để hiệu chỉnh tiêu chí cho phiếu mới. Phiếu và chứng nhận đã cấp tiếp tục tham chiếu revision gốc.

## Hoàn tác

1. Khóa luồng và dừng bản mới trước khi quay lại bản trước. Giữ lại backup, nhật ký, các phiên bản mẫu và danh sách hồ sơ bị tác động.
2. Nếu luồng mới chưa mở, đối chiếu bản sao trước thay đổi rồi hoàn tác các hàng trong kế hoạch theo điều kiện ghi đã được duyệt. Nếu đã có lượt ghi mới, xử lý hồ sơ `PENDING_APPROVAL`, phiên bản mẫu và câu trả lời mới theo phương án giữ dữ liệu do người phụ trách duyệt. Kiểm tác động tới chứng nhận và báo cáo trước khi phục hồi.
3. Xác nhận lại quyền hiệu lực và chỉ mục trước khi mở luồng. Bản cũ có thể tự đồng bộ quyền ghi cũ khi khởi động. Giữ luồng kiểm định bị khóa cho đến khi quyền ghi, nộp và xử lý hồ sơ chờ duyệt phù hợp với quyết định rollback đã được duyệt.
