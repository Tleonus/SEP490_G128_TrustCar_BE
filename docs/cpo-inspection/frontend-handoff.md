# Bàn giao frontend · Kiểm định CPO

Áp dụng cho backend `feature/cpo-inspection-db-redesign`, theo phần kiểm định showroom đã nghiệm thu ngày 26/11/2026. Tài liệu mô tả hành vi màn hình và hợp đồng HTTP để đội FE áp dụng vào giao diện hiện có. Backend đã kiểm thử với dữ liệu mô phỏng. Trước khi kiểm thử tích hợp, kiểm tra phiên bản backend, mẫu nhiên liệu và chỉ mục đã có trên môi trường FE đang gọi. [Hướng dẫn triển khai](../kan-52-inspection-rollout.md)

## 1. Ba giá trị phiên bản FE cần dùng đúng

| Người dùng đang xem gì? | Lấy dữ liệu ở đâu? | FE dùng để làm gì? |
| --- | --- | --- |
| Mẫu showroom đang áp dụng | `GET /form-templates/:templateKey` → `data.revision` | Xem tiêu chí hiện hành và lấy phiên bản cơ sở khi soạn đề xuất. |
| Phiếu của một lần kiểm định | `GET /:inspectionId` → `data.template`, `data.templateRevision`, `data.results` đối với phiếu tiêu chí | Vẽ các dòng chấm và lấy số nguyên gửi trong `baseRevision` khi lưu hoặc nộp. |
| Chứng nhận đang có hiệu lực trên xe | `GET /cars/:carId/current-certificate` → `data.templateRevision`, `data.cpoCertificateId`, `data.inspectionId` | Hiện nhãn **CPO v1**, **CPO v2** và mở đúng phiếu đã cấp mã. Nếu revision là `null`, chỉ hiện mã chứng nhận. |

Các đường dẫn rút gọn trong tài liệu đều nối sau **`/api/v1/inspections`** và dùng phiên đăng nhập nội bộ. Đường dẫn bắt đầu bằng `/api/v1/` là đường dẫn đầy đủ. ID trên đường dẫn là ObjectId, riêng `templateKey` nhận `GASOLINE` hoặc `ELECTRIC`.

Trong DB, `inspection_form_template_heads` trỏ đến phiên bản đang dùng trong `inspection_form_template_revisions`. Bản nhân viên đang soạn nằm ở `inspection_form_template_proposals`. Khi kiểm định, `inspectionrecords` lưu xe và phiên bản của lần chấm, còn `inspection_results` lưu từng kết quả theo cặp phiếu và mã tiêu chí. Backend ghép các phần này trong API chi tiết phiếu. Sự kiện công bố mẫu do backend ghi vào `activity_logs` cùng giao dịch. FE chỉ cần gửi thao tác nghiệp vụ một lần.

Ví dụ, một xe đang rao có CPO v1. Sau khi admin phát hành mẫu v2 có thêm mục phanh, màn cấu hình hiển thị **Mẫu v2**. Khi mở phiếu tái kiểm định, màn chấm hiển thị **Phiếu v2**. Trong cả hai bước đó, trang xe vẫn hiển thị **CPO v1**. Chỉ sau khi admin duyệt phiếu tái kiểm định đạt, trang xe mới hiển thị **CPO v2**.

## 2. Màn xe và phiếu kiểm định showroom

**Điểm vào từ xe.** Màn chi tiết xe hiển thị thông tin nhận dạng từ hồ sơ xe, số km đã ghi nhận và chứng nhận hiện hành nếu có. Nút **Bắt đầu kiểm định** gọi `POST /cars/:carId/draft` với body trống. HTTP 201 trả phiếu ở `data`, trong đó `data._id` là mã phiếu cho các thao tác tiếp theo. Backend chọn mẫu theo nhiên liệu của xe. Xe `DRAFT`, `INCOMING`, `REJECTED` hoặc `UNDER_INSPECTION` có thể vào luồng kiểm định lần đầu. Với xe đang hoạt động, đã có mã và ở `APPROVED_CPO` hoặc `AVAILABLE`, dùng nút **Tái kiểm định** khi mẫu hiện hành là `CRITERIA`.

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
| `DRAFT` · Nháp | **Lưu** gửi PATCH. **Nộp phiếu** gọi `POST /:inspectionId/submit` chỉ với `{"baseRevision":2}` theo revision thực tế. Khi thành công chuyển sang `PENDING_APPROVAL`. |
| `PENDING_APPROVAL` · Chờ duyệt | Hiện phiếu chỉ đọc. **Duyệt kết quả** gọi `POST /:inspectionId/approve`, body trống. Admin phải khác người nộp (`submittedBy`). **Trả về sửa** gọi `PUT /:inspectionId/reject` với `{"reason":"Cần kiểm tra lại số km thực đo"}`. Lý do từ 10 đến 1.000 ký tự sau khi cắt khoảng trắng. Phiếu về `DRAFT`, hiển thị `rejectedReason` và các kết quả đã lưu. |
| `SUBMITTED` · Đã chốt | Hiện kết luận từ `result` là `PASSED` hoặc `FAILED`. API duyệt trả `data.inspectionRecord` và `data.car`. Làm mới phiếu, xe và chứng nhận hiện hành. Kiểm định lần đầu đạt đưa xe sang `APPROVED_CPO`, không đạt sang `REJECTED`. Tái kiểm định không đạt vẫn giữ mã CPO cũ. |

**Phiếu lịch sử.** Dùng màn bảng câu hỏi hiện có khi mẫu là `QUESTIONNAIRE` hoặc phiên bản mẫu cũ thiếu `format`. Phiếu đã nộp theo mẫu đó có thể mang `checklistSnapshot`. Bản ghi `LEGACY` có thể thiếu cả `template` và snapshot, khi đó hiển thị những trường lịch sử thực sự có. Với nháp mở trước khi đổi sang tiêu chí phẳng, luôn đọc lại chính phiếu để chọn giao diện. [Vòng đời đã kiểm thử](../../tests/inspection-criteria-lifecycle.test.js)

## 3. Màn cấu hình mẫu và duyệt đề xuất

Trên màn **Mẫu kiểm định**, chọn loại nhiên liệu rồi đọc mẫu hiện hành. **Tạo đề xuất** sao chép danh sách tiêu chí vào nháp. Khi chuyển từ mẫu bảng câu hỏi, lấy `key`, `label` của năm nhóm ban đầu và đánh dấu bắt buộc. Cho sửa nhãn, thêm tiêu chí chung và chọn mục bắt buộc. Giữ nguyên `key` khi chỉ sửa tên. Khóa phải duy nhất trong một mẫu, dài tối đa 120 ký tự, dùng chữ Latin không dấu, chữ số, gạch dưới hoặc gạch ngang. Cần ít nhất một tiêu chí bắt buộc.

| Thao tác | API | Dữ liệu FE sử dụng |
| --- | --- | --- |
| Tạo đề xuất | `POST /form-template-proposals` | Gửi `{templateKey, baseRevision, groups}`. `groups` là **toàn bộ danh sách sau chỉnh sửa**, mỗi mục gồm `{key, label, required}`. Lấy `data._id` làm mã đề xuất. |
| Mở danh sách và chi tiết | `GET /form-template-proposals` và `GET /form-template-proposals/:id` | Danh sách trả `data.items` và `data.nextCursor`. Trang sau truyền `before=nextCursor`. Lọc bằng `templateKey`, `status`. Khi mở xem hoặc sửa, lấy chi tiết để có `groups`. |
| Sửa, gửi duyệt | `PUT /form-template-proposals/:id` và `POST /form-template-proposals/:id/submit` | Tác giả sửa nháp với `{baseRevision, groups}`. Nút gửi dùng body trống. Khi đã gửi, khóa trình sửa và hiện **Chờ duyệt**. |
| Admin xem hàng chờ | `GET /form-template-proposals?status=PENDING_APPROVAL` | Mở chi tiết, hiển thị loại xe, revision cơ sở và các tiêu chí mà nhân viên đề xuất. |
| Trả đề xuất | `POST /form-template-proposals/:id/return` | Gửi `{reason}` có nội dung, tối đa 1.000 ký tự. Trạng thái trả về là `DRAFT`. Dùng `reviewNote` để hiện lý do và cho tác giả sửa, gửi lại. |
| Công bố mẫu | `POST /form-template-proposals/:id/approve` | Body trống. `data` là **mẫu đã phát hành**, gồm `templateKey`, `revision`, `format`, `groups`. Làm mới mẫu hiện hành và hàng chờ. Gửi lại cùng lệnh duyệt trả đúng revision đã phát hành. |

**Xung đột phiên bản.** Nếu hai đề xuất cùng dựa trên v1, sau khi một đề xuất tạo v2, duyệt đề xuất còn lại trả `409 FORM_REVISION_CONFLICT`. Giữ nội dung đề xuất để đối chiếu. Admin trả về nháp, tác giả tải mẫu hiện hành, rà lại các thay đổi và lưu với phiên bản cơ sở mới trước khi gửi lại. Nút **Công bố** của màn tiêu chí dùng luồng đề xuất trên. Tuyến `PUT /form-templates/:templateKey` dành cho công cụ quản lý bảng câu hỏi cũ. [Kiểm thử đề xuất và phiên bản](../../tests/inspection-template-proposals.test.js)

## 4. Quyền và điều hướng

| Quyền hiệu lực | Chức năng hiển thị |
| --- | --- |
| `inspection:read` | Xem mẫu hiện hành, phiếu theo ID và chứng nhận nội bộ theo xe. |
| `inspection:write` | Tạo, sửa phiếu nháp và ký ảnh. Tạo, đọc, sửa, gửi đề xuất do tài khoản đứng tên. Quy tắc tác giả áp dụng cho **đề xuất mẫu**. |
| `inspection:submit` | Nộp phiếu xe đã lưu. Theo cấu hình mặc định, `SALES_STAFF` có thể xem và nộp, `INSPECTOR` có thể chấm và nộp. |
| Có vai trò `ADMIN` và quyền `inspection:admin` | Duyệt hoặc trả phiếu xe, xem đề xuất đã gửi, duyệt hoặc trả đề xuất. |

Lấy thông tin tài khoản từ `GET /api/v1/auth/me` và xét quyền của các vai trò đang có. Khi thiết kế màn chọn xe và màn duyệt phiếu, cần tính đến dữ liệu mà từng vai trò truy cập được.

- **Chọn xe để kiểm định.** `GET /api/v1/manage/cars` và `GET /api/v1/manage/cars/:id` đang giới hạn ở vai trò `ADMIN` hoặc `SALES_STAFF`. Người chỉ có vai trò `INSPECTOR` dùng được API phiếu khi đã có ID hợp lệ, nhưng màn tự chọn xe hoặc tải hồ sơ xe cho vai trò này cần một nguồn dữ liệu BE được cấp quyền. [Router quản lý xe](../../src/routes/carRoutes.js)
- **Tìm phiếu chờ.** Backend có hàng chờ cho *đề xuất mẫu*. Router kiểm định hiện chỉ đọc *phiếu xe* theo ID. FE có thể dùng đường dẫn chi tiết chứa `inspectionId`. Nếu sản phẩm cần danh sách “Tất cả phiếu xe chờ duyệt”, cần bổ sung API danh sách. Với thao tác tạo phiếu gặp `INSPECTION_DRAFT_EXISTS` hoặc `INSPECTION_PENDING_APPROVAL`, lấy `errors[].message` ở phần tử có `field === "inspectionId"` để mở phiếu đã tồn tại. [Router kiểm định](../../src/interface/inspection/inspectionRouter.js)

## 5. Phản hồi lỗi trên màn hình

| Phản hồi | FE xử lý |
| --- | --- |
| `400 INSPECTION_INCOMPLETE`, `422 VALIDATION_ERROR` | Giữ dữ liệu đang nhập. Ánh xạ `errors[].field` tới ô ODO hoặc dòng tiêu chí, ví dụ `results.G6_BRAKES`. |
| `409 FORM_REVISION_CONFLICT` khi sửa/nộp phiếu | Tải lại chính phiếu theo ID và đối chiếu phần chưa lưu với mẫu mà phiếu trả về. |
| `409 INSPECTION_LOCKED`, `INSPECTION_NOT_PENDING_APPROVAL`, `TEMPLATE_PROPOSAL_STATE_CONFLICT` | Tải lại đối tượng và cập nhật nút theo trạng thái mới. |
| `409 INSPECTION_TEMPLATE_NOT_AVAILABLE`, `INSPECTION_FORM_TYPE_MISMATCH` | Hiện loại nhiên liệu và thông báo cần kiểm tra cấu hình mẫu hoặc dữ liệu xe. |
| `409 INSPECTION_CRITERIA_REQUIRED` trên tuyến kiểm định nhanh | Chuyển người có quyền sang mở phiếu kiểm định theo tiêu chí. |
| `400/409 INVALID_CAR_STATUS` | Làm mới trạng thái xe. Xe có thể vừa được giữ chỗ khi admin đang duyệt tái kiểm định. |
| `403 INSPECTION_SELF_APPROVAL` hoặc lỗi quyền khác | Với tự duyệt phiếu xe, yêu cầu admin khác xử lý. Với lỗi quyền, cập nhật thao tác theo tài khoản. |
| `404 CPO_CERTIFICATE_NOT_FOUND` | Hiện “Chưa có chứng nhận hiện hành để hiển thị”. Phân biệt với lỗi tải mạng và `CAR_NOT_FOUND`. |

## 6. Giao diện dành cho khách

**Báo cáo của xe showroom đã cấp CPO** đã có API công khai. `GET /api/v1/public/cars/:id/inspection-report` trả mã chứng nhận, ngày cấp, thông tin xe và danh sách tiêu chí đạt ở `data.groups`. Vẽ theo dữ liệu trả về, kể cả khi nhiều hơn năm mục. Ảnh và ghi chú kiểm định thuộc màn nội bộ. Bản JSON công khai hiện chưa có trường phiên bản để gắn nhãn “CPO vN”. Nút tải chứng nhận dùng `GET /api/v1/public/cars/:id/cpo-certificate.pdf`. [Hợp đồng báo cáo công khai](../../src/interface/inspection-report/inspectionReportHandler.js)

**Tự đánh giá xe khách để bán** là luồng đã thiết kế trong ERD và đang chờ API nghiệp vụ khách hàng.

1. Khách chọn loại xe, khai thông tin xe, tình trạng, trả lời tiêu chí từ mẫu showroom và tải ảnh ban đầu. Kết quả hiển thị rõ **Tự đánh giá đạt** hoặc **Tự đánh giá không đạt**. Chứng nhận CPO chỉ được cấp qua kiểm định showroom.
2. Khách có kết quả đạt có thể chọn **Định giá tham khảo**, bổ sung ảnh cho riêng lượt định giá rồi xem khoảng giá AI. Giữ tách ảnh khai ban đầu và ảnh bổ sung theo lượt định giá.
3. Khách có thể **Gọi showroom** hoặc **Yêu cầu tư vấn bán xe**, kể cả khi bỏ qua định giá hoặc tự đánh giá không đạt. Số liên hệ có thể lấy từ `GET /api/v1/public/base-settings` ở `data.contact.phoneDisplay` và `data.contact.phoneHref`. `POST /api/v1/leads` hiện hỗ trợ tư vấn chung. Liên kết yêu cầu bán với đúng hồ sơ tự đánh giá còn chờ hợp đồng BE.

Khi làm FE đợt showroom, có thể tích hợp báo cáo công khai ngay. Phần tự đánh giá, bộ ảnh khách, lượt định giá và tư vấn gắn hồ sơ chỉ mở gửi thật khi có API cho khách. [Luồng khách trong ERD](srs/cpo-inspection-erd.md)

## 7. Ca nghiệm thu FE

1. Xe đang rao có CPO v1. Tạo đề xuất từ mẫu v1, thêm tiêu chí phanh, gửi duyệt. Trả đề xuất về sửa rồi gửi lại. Sau khi admin công bố, màn mẫu hiện v2 và xe vẫn hiện CPO v1.
2. Mở phiếu tái kiểm định của xe đó. Thấy đủ sáu dòng theo v2. Lưu riêng một dòng có ảnh và ghi chú, tải lại trang, sửa kết quả. Ảnh và ghi chú đã lưu vẫn còn.
3. Bỏ trống một mục bắt buộc thì chưa nộp được. Chọn **Không thể kiểm tra** cho mục đó, nộp và để admin duyệt. Phiếu chốt không đạt, xe vẫn có CPO v1.
4. Ở lần tái kiểm định đạt, trong lúc chờ duyệt xe vẫn hiện v1. Admin khác người nộp duyệt xong, xe hiện CPO v2, giữ trạng thái đang rao và vẫn mở được phiếu v1 qua ID cũ.
5. Mở một phiếu bảng câu hỏi cũ và một chứng nhận thiếu phiên bản. Phiếu cũ đọc được nội dung đã lưu. Chứng nhận thiếu phiên bản chỉ hiện mã. Kiểm lại bằng tài khoản kiểm định viên, nhân viên bán hàng và admin.
