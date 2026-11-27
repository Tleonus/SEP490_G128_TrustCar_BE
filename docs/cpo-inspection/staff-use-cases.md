# Use case nhân sự showroom · UC-27 đến UC-51

Danh sách theo phân công ngày 27/11/2026. Một tài khoản có thể có nhiều vai trò và nhận các chức năng của toàn bộ vai trò được gán. Phạm vi triển khai trên nhánh này là UC-31 đến UC-34. [Luồng CPO và ca nghiệm thu](frontend-handoff.md)

| ID | Use case | Vai trò | FE | Mô tả |
| --- | --- | --- | --- | --- |
| UC-27 | Intake a vehicle into stock | Sales Staff | FE-09 | Register a vehicle with a unique VIN and license plate. Generate its stock code in `TC-YYYY-NNNN` format and set its status to `INCOMING`. |
| UC-28 | Manage vehicle inventory, images, and status | Sales Staff | FE-09, FE-16 | Update vehicle details and pricing, manage Cloudinary photos, move vehicles through valid inventory statuses and view sold vehicle history. |
| UC-29 | Soft-delete a vehicle record | Sales Staff | FE-09 | Remove a vehicle from active management through deactivation or delisting while preserving its audit history and transaction references. |
| UC-30 | Monitor aging inventory and apply markdowns | Sales Staff, Admin | FE-16 | View stock age and price history and apply aging markdowns within the configured floor price. |
| UC-31 | Create a vehicle inspection | Inspector | FE-20 | Open an inspection for an eligible vehicle and use the active template for its fuel type. Record measured mileage, score each criterion and attach evidence when needed. Submit the saved inspection to finalize its result. |
| UC-32 | Edit a vehicle inspection draft | Inspector | FE-21 | Reopen the vehicle’s existing draft. Update measured mileage, criterion results, notes and evidence under the template revision attached to the draft. Save changes and resume later or submit when the required data is complete. A vehicle that failed a finalized inspection can start a new inspection with its own record. |
| UC-33 | Publish a CPO vehicle for public sale | Inspector | FE-21 | On inspection submission, evaluate the required criteria. If they pass, finalize the inspection, issue the CPO certificate and publish the vehicle as `AVAILABLE`. If a first inspection fails, finalize the result as `FAILED` and set the vehicle to `REJECTED`. |
| UC-34 | View CPO certificates and print QR labels | Sales Staff, Admin, Inspector | FE-20, FE-21 | Search issued certificates, inspect the report for the certifying inspection, download its PDF and print a QR label when a verification QR is available. |
| UC-35 | Work the lead pipeline and hot leads | Sales Staff | FE-10 | Filter and search leads, prioritize behavior-scored HOT leads, view enquiry details and append immutable activity notes. |
| UC-36 | Handle test-drive and service appointments | Sales Staff | FE-07, FE-08 | View list and calendar schedules. Confirm, reschedule, cancel or close visits as `COMPLETED` with feedback or as `NO_SHOW`. |
| UC-37 | Book a test-drive visit on behalf of a customer | Sales Staff | FE-06, FE-08 | Find an existing customer, check slot availability and book a test drive on the customer’s behalf. |
| UC-38 | Confirm, complete, or cancel deposits and sales | Sales Staff | FE-10, FE-16, FE-22 | Confirm deposit receipt, cancel unpaid holds, or complete full payment to close the sale and transition the car to SOLD. |
| UC-39 | Refund a paid deposit | Admin | FE-22 | Record a refund amount, reference code, and note for a paid deposit transaction. |
| UC-40 | Generate AI marketing captions | Sales Staff | FE-25 | Generate length- and rate-limited social captions by tone and platform using verified vehicle facts. |
| UC-41 | Publish a vehicle post to Facebook Page | Sales Staff | FE-25 | Publish a selected marketing caption and vehicle image on the showroom’s Facebook Page via the Facebook Graph API. |
| UC-42 | Manage staff accounts | Admin | FE-13 | Create, view, update, activate or deactivate internal staff accounts. |
| UC-43 | Assign multiple roles to a staff account | Admin | FE-13 | Update the full set of roles assigned to a staff account. Revoke active sessions so the updated permissions apply on the next sign-in. |
| UC-44 | Lock or unlock a user account | Admin | FE-13 | Lock an account with a mandatory audit reason and revoke active sessions, or clear administrative and rate-limit locks. |
| UC-45 | Reset a staff password | Admin | FE-13 | Generate and email a new password to a staff member and revoke active sessions. |
| UC-46 | Configure base showroom and test-drive settings | Admin | FE-11 | Update showroom contact details, social links, operating hours and test-drive slot capacity. Apply the changes immediately. |
| UC-47 | Manage showroom service packages | Sales Staff | FE-07 | Create, update or deactivate a service package with a code, reference price, description and estimated duration. |
| UC-48 | Configure loan calculator parameters | Admin | FE-24 | Configure preferred and floating annual interest rates, the minimum down-payment ratio and the permitted loan terms. |
| UC-49 | View the operations overview dashboard | Sales Staff, Admin | FE-14 | View stock by status, monthly revenue and sold-vehicle metrics, brand distribution and recent lead, sale and intake records. |
| UC-50 | Explore business analytics | Admin | FE-14 | Analyze date-filtered monthly sales, average days in stock, the lead conversion funnel, top vehicles and revenue by sales staff. |
| UC-51 | Inspect system audit and email logs | Admin | FE-14 | Filter and review immutable audit events with before-and-after changes and inspect outbound email delivery logs. |

## Ghi chú triển khai

- **UC-31 đến UC-33.** **Kiểm định xe** là nơi chấm và nộp phiếu. **Mẫu kiểm định** là nơi quản lý cấu hình phiếu sử dụng. Backend chốt và đưa xe đạt lên danh mục ngay tại thao tác nộp. FE cần chuyển sang đọc kết quả của thao tác này. [Router kiểm định](../../src/interface/inspection/inspectionRouter.js)
- **UC-34.** Danh sách và chi tiết chứng nhận dùng API CPO cho cả ba vai trò. Phiên bản lấy từ đúng phiếu đã cấp mã đang có trên xe. [Hợp đồng FE](frontend-handoff.md)
