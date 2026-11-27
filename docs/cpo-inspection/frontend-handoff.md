# Bàn giao frontend · Kiểm định CPO

Luồng UC-31 đến UC-34 cập nhật ngày 27/11/2026. Khi kiểm định viên nộp và các tiêu chí bắt buộc đều đạt, xe được cấp CPO và xuất hiện trên danh mục ngay. Tài liệu mô tả hợp đồng backend mới để nối vào FE. [Danh sách UC-27 đến UC-51](staff-use-cases.md)

## Phân công trên tài khoản nhiều vai trò

| Vai trò | Mục CPO trong menu | Công việc |
| --- | --- | --- |
| `ADMIN` | **Chứng nhận CPO**, **Duyệt đề xuất mẫu** | Tra cứu chứng nhận theo UC-34. Duyệt đề xuất thay đổi tiêu chí theo quy trình cấu hình mẫu hiện hành. |
| `INSPECTOR` | **Kiểm định xe**, **Mẫu kiểm định**, **Chứng nhận CPO** | Bắt đầu, tiếp tục, kiểm định lại và nộp phiếu. Xem mẫu hiện hành, soạn và gửi đề xuất thay đổi mẫu. Tra cứu chứng nhận theo UC-34. |
| `SALES_STAFF` | **Chứng nhận CPO** | Xem danh sách xe đã được cấp CPO, mở chi tiết, tải PDF và in tem QR khi có mã xác minh. |

Một tài khoản có nhiều vai trò nhận tập chức năng hợp nhất. Hiện **Chứng nhận CPO** một lần nếu tài khoản có từ hai vai trò trở lên. FE đọc toàn bộ `roleNames` và quyền hiệu lực, áp dụng cùng điều kiện cho menu, URL trực tiếp và nút thao tác.

Phạm vi thay đổi được hiểu là bỏ duyệt **phiếu từng xe**. Phần **Duyệt đề xuất mẫu** ở trên dựa trên quy trình cấu hình mẫu đã chốt trước đó. Đề xuất mẫu và phiếu của xe có hai vòng đời riêng.

## 1. Ba giá trị phiên bản FE cần dùng đúng

| Người dùng đang xem gì? | Lấy dữ liệu ở đâu? | FE dùng để làm gì? |
| --- | --- | --- |
| Mẫu showroom đang áp dụng | `GET /form-templates/:templateKey` → `data.revision` | Xem tiêu chí hiện hành và lấy phiên bản cơ sở khi soạn đề xuất. |
| Phiếu của một lần kiểm định | `GET /:inspectionId` → `data.template`, `data.templateRevision`, `data.results` đối với phiếu tiêu chí | Vẽ các dòng chấm và lấy số nguyên gửi trong `baseRevision` khi lưu hoặc nộp. |
| Chứng nhận đang có hiệu lực trên xe | `GET /cars/:carId/current-certificate` → `data.templateRevision`, `data.cpoCertificateId`, `data.inspectionId` | Hiện nhãn **CPO v1**, **CPO v2** và mở đúng phiếu đã cấp mã. Nếu revision là `null`, chỉ hiện mã chứng nhận. |

Các đường dẫn rút gọn trong tài liệu đều nối sau **`/api/v1/inspections`** và dùng phiên đăng nhập nội bộ. Đường dẫn bắt đầu bằng `/api/v1/` là đường dẫn đầy đủ. ID trên đường dẫn là ObjectId, riêng `templateKey` nhận `GASOLINE` hoặc `ELECTRIC`.

Trong DB, `inspection_form_template_heads` trỏ đến phiên bản đang dùng trong `inspection_form_template_revisions`. Bản nhân viên đang soạn nằm ở `inspection_form_template_proposals`. Khi kiểm định, `inspectionrecords` lưu xe và phiên bản của lần chấm, còn `inspection_results` lưu từng kết quả theo cặp phiếu và mã tiêu chí. Backend ghép các phần này trong API chi tiết phiếu. Sự kiện công bố mẫu do backend ghi vào `activity_logs` cùng giao dịch. FE chỉ cần gửi thao tác nghiệp vụ một lần.

Ví dụ, một xe đang rao có CPO v3. Sau khi phát hành mẫu v4, màn cấu hình hiển thị **Mẫu v4** và xe vẫn hiển thị **CPO v3**. Khi kiểm định viên nộp phiếu tái kiểm định đạt theo v4, xe hiển thị **CPO v4**.

## 2. Màn xe và phiếu kiểm định showroom

### Danh sách xe và nút theo trạng thái

| Trạng thái trên màn Kiểm định xe | Điều kiện | Nút và đích đến |
| --- | --- | --- |
| **Mới nhập** | Xe `INCOMING` hoặc hồ sơ xe `DRAFT`, đủ điều kiện kiểm định và chưa có phiếu mở. | **Bắt đầu kiểm định** gọi `POST /cars/:carId/draft`. Mở phiếu vừa tạo từ `data._id`. |
| **Không đạt** | Xe `REJECTED` sau kiểm định lần đầu và chưa có phiếu mở. | **Kiểm định lại** gọi `POST /cars/:carId/draft` để tạo lượt mới. Phiếu không đạt trước đó vẫn tra được theo ID cũ. |
| **Đang kiểm định** | Xe có phiếu mở `DRAFT`. | **Tiếp tục kiểm định** mở đúng `inspectionId` đã có qua `GET /:inspectionId` để chấm, lưu hoặc nộp tiếp. |
| **Chờ xử lý phiếu cũ** | Xe có phiếu `PENDING_APPROVAL` từ luồng đã triển khai trước đây. | **Xem hồ sơ** mở phiếu đã lưu ở chế độ chỉ đọc. Xử lý theo phương án chuyển tiếp trước khi xe có thể nộp theo luồng mới. |

Ưu tiên trạng thái phiếu mở khi hiển thị danh sách. Kết quả đã chốt thành công xuất hiện ở **Chứng nhận CPO** và xe `AVAILABLE` xuất hiện trên danh mục công khai. Nếu xe `UNDER_INSPECTION` thiếu phiếu mở, hiển thị trạng thái dữ liệu cần kiểm tra. Khi xe có phiếu tái kiểm định đang mở, hiển thị tiến độ của phiếu và chứng nhận hiện hành trên hai vị trí riêng.

Tên xe hiển thị hãng, dòng và phiên bản xe. Trạng thái xuất hiện ở cột hoặc nhãn riêng. Khi cập nhật bộ demo, đưa các hậu tố như “Không đạt”, “Chờ duyệt” và “Đang chấm” ra khỏi tên xe mẫu.

**Điểm vào từ xe.** Màn chi tiết xe hiển thị dữ liệu nhận dạng, số km ghi nhận và chứng nhận hiện hành. Khi tạo phiếu, backend chọn mẫu theo nhiên liệu. Nếu có phiếu mở do thao tác ở tab khác, FE tải lại danh sách và mở phiếu hiện có theo ID phản hồi.

**Màn chấm phiếu.** Khi mở màn hình từ liên kết hoặc tải lại trang, gọi `GET /:inspectionId`. Nếu `data.template.format === "CRITERIA"`, sắp dòng theo thứ tự `data.template.groups[]`. Mỗi dòng lấy tên từ `label`, dấu bắt buộc từ `required` và ghép kết quả qua `group.key === result.criterionId`. Mẫu ban đầu có năm tiêu chí về khung gầm/thân vỏ, ngập nước, động cơ/hộp số, ODO và điện/an toàn. Mục thứ sáu, thứ bảy sẽ xuất hiện tự động theo mẫu của phiếu.

| Thành phần | Hành vi FE |
| --- | --- |
| ODO thực đo | Một ô số nguyên từ 0. Khi nộp, ODO phải từ số km đang lưu của xe trở lên. ODO thực đo và kết quả của tiêu chí kiểm tra ODO là hai dữ liệu riêng. |
| Kết quả từng dòng | Ban đầu để **Chưa chấm**. Ba lựa chọn đã chấm là **Đạt** (`PASS`), **Không đạt** (`FAIL`) và **Không thể kiểm tra** (`NOT_CHECKABLE`). |
| Ghi chú và ảnh minh chứng | Tùy chọn trên từng dòng. Ghi chú tối đa 1.000 ký tự, tối đa 5 ảnh. Màn mới chỉ cần thông tin xe để đọc, ODO và các dòng chấm. Các ô xác nhận lại hãng/dòng, câu hỏi con, ảnh bốn góc và lỗi nhỏ thuộc phiếu bảng câu hỏi cũ. |
| Điều kiện nộp | Đã lưu ODO hợp lệ và đã chọn kết quả cho mọi dòng bắt buộc. Một dòng bắt buộc có `FAIL` hoặc `NOT_CHECKABLE` vẫn cho nộp để duyệt. Khi chốt, phiếu chỉ đạt nếu **tất cả dòng bắt buộc** là `PASS`. |

**Lưu nháp.** Gọi `PATCH /:inspectionId`. Ví dụ dưới đây cập nhật ODO và một dòng của phiếu v2. Có thể chỉ gửi các dòng đã sửa. Với mỗi dòng được gửi lại, gửi cả ghi chú và danh sách ảnh muốn giữ vì backend ghi thay nội dung của dòng đó. Các dòng vắng mặt giữ kết quả cũ.

```json
{
  "baseRevision": 2,
  "odo": 51000,
  "results": [
    {
      "criterionId": "G6_BRAKES",
      "outcome": "PASS",
      "note": "Đã kiểm tra phanh tại showroom.",
      "evidenceImages": []
    }
  ]
}
```

**Tải ảnh.** Khi phiếu còn nháp, gọi `POST /:inspectionId/upload-signature`. Dùng `cloudName`, `apiKey`, `timestamp`, `signature`, `folder` và `allowedFormats` trả về để upload ảnh trực tiếp lên Cloudinary. Truyền đúng `folder` và tham số đã ký `allowed_formats` cho ảnh JPG, PNG hoặc WebP. Lưu `secure_url` gốc vào `results[].evidenceImages` của đúng phiếu. Đợi upload và lần lưu cuối hoàn tất trước khi cho bấm **Nộp phiếu**.

| Trạng thái phiếu | Thao tác và phản hồi |
| --- | --- |
| `DRAFT` · Nháp | **Lưu** gửi PATCH. **Nộp phiếu** gọi `POST /:inspectionId/submit` với `baseRevision` của phiếu. Nộp đủ dữ liệu sẽ tính kết quả và chốt sang `SUBMITTED`. |
| `SUBMITTED` · Đạt | Hiển thị `result: PASSED` và mã CPO. Backend cập nhật trạng thái xe sang `AVAILABLE`, ghi thời điểm lên sàn nếu chưa có và cập nhật dữ liệu xác minh. FE làm mới danh sách phiếu, chứng nhận và danh mục công khai. |
| `SUBMITTED` · Không đạt | Hiển thị `result: FAILED` và các tiêu chí không đạt. Kiểm định lần đầu không đạt đưa xe sang `REJECTED`. Tái kiểm định không đạt tiếp tục áp dụng quy tắc giữ chứng nhận và trạng thái kinh doanh đang có cho xe đã cấp CPO. |
| `PENDING_APPROVAL` · Phiếu cũ | Hiển thị dữ liệu đã lưu ở chế độ chỉ đọc. Admin có thể trả phiếu về nháp để Inspector rà soát và nộp lại theo luồng hiện hành. |

**Phiếu lịch sử.** Dùng màn bảng câu hỏi hiện có khi mẫu là `QUESTIONNAIRE` hoặc phiên bản mẫu cũ thiếu `format`. Phiếu đã nộp theo mẫu đó có thể mang `checklistSnapshot`. Bản ghi `LEGACY` có thể thiếu cả `template` và snapshot, khi đó hiển thị những trường lịch sử thực sự có. Với nháp mở trước khi đổi sang tiêu chí phẳng, luôn đọc lại chính phiếu để chọn giao diện. [Vòng đời đã kiểm thử](../../tests/inspection-criteria-lifecycle.test.js)

## 3. Màn cấu hình mẫu và duyệt đề xuất

Kiểm định viên dùng màn **Mẫu kiểm định** để chọn nhiên liệu, xem mẫu và soạn đề xuất. Admin xử lý tại **Duyệt đề xuất mẫu**. Khi chuyển từ mẫu bảng câu hỏi, lấy `key`, `label` của năm nhóm ban đầu và đánh dấu bắt buộc. Cho sửa nhãn, thêm tiêu chí chung và chọn mục bắt buộc. Giữ nguyên `key` khi chỉ sửa tên. Khóa phải duy nhất trong một mẫu, dài tối đa 120 ký tự, dùng chữ Latin không dấu, chữ số, gạch dưới hoặc gạch ngang. Cần ít nhất một tiêu chí bắt buộc.

| Thao tác | API | Dữ liệu FE sử dụng |
| --- | --- | --- |
| Tạo đề xuất | `POST /form-template-proposals` | Gửi `{templateKey, baseRevision, groups}`. `groups` là **toàn bộ danh sách sau chỉnh sửa**, mỗi mục gồm `{key, label, required}`. Lấy `data._id` làm mã đề xuất. |
| Mở danh sách và chi tiết | `GET /form-template-proposals` và `GET /form-template-proposals/:id` | Danh sách trả `data.items` và `data.nextCursor`. Trang sau truyền `before=nextCursor`. Lọc bằng `templateKey`, `status`. Khi mở xem hoặc sửa, lấy chi tiết để có `groups`. |
| Sửa, gửi duyệt | `PUT /form-template-proposals/:id` và `POST /form-template-proposals/:id/submit` | Tác giả sửa nháp với `{baseRevision, groups}`. Nút gửi dùng body trống. Khi đã gửi, khóa trình sửa và hiện **Chờ duyệt**. |
| Admin xem hàng chờ | `GET /form-template-proposals?status=PENDING_APPROVAL` | Mở chi tiết, hiển thị loại xe, revision cơ sở và các tiêu chí mà nhân viên đề xuất. |
| Trả đề xuất | `POST /form-template-proposals/:id/return` | Gửi `{reason}` có nội dung, tối đa 1.000 ký tự. Trạng thái trả về là `DRAFT`. Dùng `reviewNote` để hiện lý do và cho tác giả sửa, gửi lại. |
| Công bố mẫu | `POST /form-template-proposals/:id/approve` | Body trống. `data` là **mẫu đã phát hành**, gồm `templateKey`, `revision`, `format`, `groups`. Làm mới mẫu hiện hành và hàng chờ. Gửi lại cùng lệnh duyệt trả đúng revision đã phát hành. |

**Xung đột phiên bản.** Nếu hai đề xuất cùng dựa trên v1, sau khi một đề xuất tạo v2, duyệt đề xuất còn lại trả `409 FORM_REVISION_CONFLICT`. Giữ nội dung đề xuất để đối chiếu. Admin trả về nháp, tác giả tải mẫu hiện hành, rà lại các thay đổi và lưu với phiên bản cơ sở mới trước khi gửi lại. Nút **Công bố** của màn tiêu chí dùng luồng đề xuất trên. Tuyến `PUT /form-templates/:templateKey` dành cho công cụ quản lý bảng câu hỏi cũ. [Kiểm thử đề xuất và phiên bản](../../tests/inspection-template-proposals.test.js)

## 4. Hợp đồng API cho FE

| API | Quyền và phản hồi |
| --- | --- |
| `GET /queue?status=IN_PROGRESS&page=1&limit=20` | `INSPECTOR` có quyền đọc. Hỗ trợ `NEW`, `FAILED`, `IN_PROGRESS`, `PENDING_APPROVAL` và `search`. `data[]` là xe, có `status` của kho, `inspectionStatus` của danh sách và `openInspection` là `{_id,status,templateKey,checklistVersion}` hoặc `null`. Phân trang theo `meta`. |
| `GET /cars/:carId` | `INSPECTOR` có quyền đọc. Trả `data.car` và `data.openInspection` để chọn nút ở màn hồ sơ. |
| `POST /:inspectionId/submit` | `INSPECTOR` có quyền nộp. Gửi `{baseRevision}`. Trả `data.car` và `data.inspectionRecord` đã chốt. FE dùng kết quả trả về để cập nhật màn hình ngay. |
| `GET /certificates?search=&page=1&limit=20` | Ba vai trò nội bộ có quyền đọc. Trả `data[]` gồm thông tin xe, mã hiện hành, `inspectionId`, `hasVerificationQr` và `meta` phân trang. |
| `GET /certificates/:carId` | Ba vai trò nội bộ có quyền đọc. Trả thông tin xe, ID phiếu đã cấp, loại mẫu, `templateRevision` và `verificationPath` nếu QR có hiệu lực. Dùng đường dẫn báo cáo và PDF công khai ở mục 6 cho xe đủ điều kiện hiển thị công khai. |

FE xác nhận thao tác **Nộp phiếu** vì kết quả đạt sẽ đưa xe lên danh mục. Menu admin dùng **Duyệt đề xuất mẫu**. Tuyến admin duyệt phiếu xe đã được bỏ khỏi router. Admin có thể trả phiếu lịch sử đang `PENDING_APPROVAL` về nháp qua tuyến `PUT /:inspectionId/reject` để kiểm định viên xem lại trước khi nộp. Các phiếu như Mazda 3 demo trên `trustcar_dev` chỉ đổi khi được xử lý chủ động. Tuyến mở bán riêng dành cho xe cũ đã ở `APPROVED_CPO`, do Inspector có quyền nộp thực hiện. [Router kiểm định](../../src/interface/inspection/inspectionRouter.js)

## 5. Phản hồi lỗi trên màn hình

| Phản hồi | FE xử lý |
| --- | --- |
| `400 INSPECTION_INCOMPLETE`, `422 VALIDATION_ERROR` | Giữ dữ liệu đang nhập. Ánh xạ `errors[].field` tới ô ODO hoặc dòng tiêu chí, ví dụ `results.G6_BRAKES`. |
| `409 FORM_REVISION_CONFLICT` khi sửa/nộp phiếu | Tải lại chính phiếu theo ID và đối chiếu phần chưa lưu với mẫu mà phiếu trả về. |
| `409 INSPECTION_LOCKED` hoặc `TEMPLATE_PROPOSAL_STATE_CONFLICT` | Tải lại đối tượng và cập nhật nút theo trạng thái mới. |
| `409 INSPECTION_TEMPLATE_NOT_AVAILABLE`, `INSPECTION_FORM_TYPE_MISMATCH` | Hiện loại nhiên liệu và thông báo cần kiểm tra cấu hình mẫu hoặc dữ liệu xe. |
| `409 INSPECTION_CRITERIA_REQUIRED` trên tuyến kiểm định nhanh | Chuyển người có quyền sang mở phiếu kiểm định theo tiêu chí. |
| `400/409 INVALID_CAR_STATUS` | Làm mới trạng thái xe. Xe có thể vừa được giữ chỗ trong lúc chốt tái kiểm định. |
| `403` | Tải lại quyền hiệu lực và cập nhật thao tác theo tài khoản. |
| `404 CPO_CERTIFICATE_NOT_FOUND` | Hiện “Chưa có chứng nhận hiện hành để hiển thị”. Phân biệt với lỗi tải mạng và `CAR_NOT_FOUND`. |

## 6. Giao diện dành cho khách

**Báo cáo của xe showroom đã cấp CPO** đã có API công khai. `GET /api/v1/public/cars/:id/inspection-report` trả mã chứng nhận, ngày cấp, thông tin xe và danh sách tiêu chí đạt ở `data.groups`. Vẽ theo dữ liệu trả về, kể cả khi nhiều hơn năm mục. Ảnh và ghi chú kiểm định thuộc màn nội bộ. Bản JSON công khai hiện chưa có trường phiên bản để gắn nhãn “CPO vN”. Nút tải chứng nhận dùng `GET /api/v1/public/cars/:id/cpo-certificate.pdf`. [Hợp đồng báo cáo công khai](../../src/interface/inspection-report/inspectionReportHandler.js)

**Tự đánh giá xe khách để bán** là luồng đã thiết kế trong ERD và đang chờ API nghiệp vụ khách hàng.

1. Khách chọn loại xe, khai thông tin xe, tình trạng, trả lời tiêu chí từ mẫu showroom và tải ảnh ban đầu. Kết quả hiển thị rõ **Tự đánh giá đạt** hoặc **Tự đánh giá không đạt**. Chứng nhận CPO chỉ được cấp qua kiểm định showroom.
2. Khách có kết quả đạt có thể chọn **Định giá tham khảo**, bổ sung ảnh cho riêng lượt định giá rồi xem khoảng giá AI. Giữ tách ảnh khai ban đầu và ảnh bổ sung theo lượt định giá.
3. Khách có thể **Gọi showroom** hoặc **Yêu cầu tư vấn bán xe**, kể cả khi bỏ qua định giá hoặc tự đánh giá không đạt. Số liên hệ có thể lấy từ `GET /api/v1/public/base-settings` ở `data.contact.phoneDisplay` và `data.contact.phoneHref`. `POST /api/v1/leads` hiện hỗ trợ tư vấn chung. Liên kết yêu cầu bán với đúng hồ sơ tự đánh giá còn chờ hợp đồng BE.

Khi làm FE đợt showroom, có thể tích hợp báo cáo công khai ngay. Phần tự đánh giá, bộ ảnh khách, lượt định giá và tư vấn gắn hồ sơ chỉ mở gửi thật khi có API cho khách. [Luồng khách trong ERD](srs/cpo-inspection-erd.md)

## 7. Ca nghiệm thu FE

| Ca test | Kết quả mong đợi |
| --- | --- |
| Đăng nhập bằng ba tài khoản đơn vai trò rồi thử tài khoản có cả ba vai trò | Cả ba xem được danh sách chứng nhận. Chỉ tài khoản có `INSPECTOR` thực hiện kiểm định xe. Tài khoản nhiều vai trò thấy các mục hợp nhất một lần, bất kể thứ tự `roleNames`. |
| Mở xe mới nhập, xe không đạt và xe có phiếu nháp | Thấy **Bắt đầu kiểm định**, **Kiểm định lại**, **Tiếp tục kiểm định**. Nút tiếp tục mở phiếu cũ với kết quả đã lưu. Tên xe chỉ có thông tin nhận dạng. |
| Nộp phiếu thiếu ODO hoặc thiếu kết quả bắt buộc | Hiện lỗi tại ô tương ứng. Phiếu vẫn là `DRAFT` và xe chưa xuất hiện trên danh mục công khai. |
| Nộp phiếu lần đầu có tiêu chí bắt buộc `FAIL` hoặc `NOT_CHECKABLE` | Phiếu chốt `FAILED`. Xe chuyển `REJECTED` và hiện nút **Kiểm định lại**. |
| Nộp phiếu lần đầu đủ điều kiện và đạt | Phiếu chốt `PASSED`, xe chuyển `AVAILABLE`, có mã CPO và xuất hiện công khai. Thử bấm nộp hai lần và xác nhận hệ thống chỉ cấp một chứng nhận cho phiếu. |
| Đổi mẫu từ v3 lên v4 rồi mở phiếu mới cho xe có CPO v3 | Xe vẫn hiện CPO v3 trước khi nộp. Chỉ khi nộp kết quả tái kiểm định đạt mới hiện CPO v4. Phiếu cũ vẫn mở được theo ID gốc. |
| Mở phiếu lịch sử và chứng nhận chưa có thông tin phiên bản | Hiển thị được dữ liệu đã lưu. Chứng nhận thiếu revision chỉ hiển thị mã. |
