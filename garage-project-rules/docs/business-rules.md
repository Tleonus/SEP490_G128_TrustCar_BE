# Quy tắc nghiệp vụ gara và xe cũ

> Đọc cùng [mục lục và quy trình đọc bắt buộc](README.md).

## Nghiệp vụ gara và xe cũ

Các nhóm dưới đây là checklist để đối chiếu yêu cầu, không tự động thuộc phạm vi triển khai:

- Xe và hồ sơ xe: mã nội bộ, VIN/số khung, biển số, hãng/dòng, năm sản xuất, số km, tình trạng, giấy tờ và lịch sử liên quan nếu được yêu cầu.
- Khách hàng và chủ xe: phân biệt khách, người liên hệ, chủ sở hữu hiện tại và lịch sử sở hữu nếu hệ thống cần.
- Nếu có sửa chữa: tiếp nhận, kiểm tra, báo giá, khách duyệt, phân công, sửa chữa, nghiệm thu, thanh toán, bàn giao.
- Nếu có mua bán xe cũ: nhập xe, kiểm định, chi phí tân trang, định giá, đặt cọc, bán xe, bàn giao và bảo hành theo yêu cầu.
- Nếu có phụ tùng/kho: nhập, xuất, hoàn trả, tồn kho và nhà cung cấp.
- Nếu có tài chính: hóa đơn, thu/chi, công nợ, đặt cọc, hoàn tiền và báo cáo theo phạm vi đã chốt.

Bất biến cần bảo vệ khi chức năng tương ứng tồn tại:

- Không đồng nhất biển số với định danh bất biến của xe. Không tự áp đặt uniqueness/nullability của VIN, biển số hoặc số điện thoại khi chưa xác nhận quy tắc dữ liệu.
- Không tự quyết thuế, chiết khấu, đặt cọc, phí hủy, bảo hành, làm tròn hoặc cách tính lợi nhuận; đọc tài liệu hoặc hỏi người dùng.
- Tiền dùng đơn vị/kiểu biểu diễn chính xác đã thống nhất; tránh phép tính số thực gây sai số. UI dùng helper chung, locale `vi-VN`; xác nhận tiền tệ trước khi mặc định VND.
- Chốt state machine và quyền chuyển trạng thái trước khi triển khai; không tự nhảy trạng thái hoặc chỉ kiểm soát bằng nút trên UI.
- Không sửa/xóa âm thầm chứng từ đã chốt, lịch sử sửa chữa, thanh toán hoặc biến động kho. Cơ chế điều chỉnh/hủy và audit phải theo nghiệp vụ được duyệt.
- Nếu cần lưu giá tại thời điểm giao dịch, lịch sử thay đổi hoặc chống tồn kho âm, đề xuất thiết kế và xin phép DB; không tự thêm field/table.
- Thời gian phải có quy ước lưu trữ/múi giờ hiển thị; báo cáo ngày/tháng dùng cùng quy ước, không phụ thuộc ngầm timezone máy chạy.
