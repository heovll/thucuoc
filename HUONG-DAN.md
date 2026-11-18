# Nhắc cước – app nhắc thanh toán cho khách hàng & CTV

Một hệ thống gồm 2 phần, chạy chung một máy chủ:

| Phần | Địa chỉ | Ai dùng |
|---|---|---|
| **App điện thoại** | `/app/` | Khách hàng (xem cước, nhận nhắc) và CTV (thu cước) |
| **Trang quản trị** | `/admin/` | Quản trị viên |

## 1. Chạy thử trên máy

Cần Node.js 22.13 trở lên (máy này đang có Node 26).

```bash
npm install
```

```bash
npm start
```

- App: http://localhost:3000/app/
- Quản trị: http://localhost:3000/admin/
- Lần chạy đầu, mật khẩu tài khoản `admin` được ghi vào `data/MAT-KHAU-ADMIN-LAN-DAU.txt`. Đăng nhập xong, hãy đổi mật khẩu (mục **Cài đặt**) rồi xoá file đó.

## 2. Quy trình mỗi kỳ cước

1. **Đưa file cước lên GitHub** (ví dụ `CUOC_T12.xlsx`).
   - Cột cần có: **Tên KH, Số TB, Số ĐT liên hệ, Tổng cước, Mã CTV, Tên địa bàn, Mã hợp đồng**. Các cột khác được bỏ qua.
   - Nếu cột *Số ĐT liên hệ* là công thức `VLOOKUP` sang file khác, hãy chọn cột → **Copy → Paste Values** trước khi đưa lên, nếu không số điện thoại sẽ trống.
2. Quản trị → **Nhập dữ liệu** → dán link GitHub → chọn **Tạo kỳ cước mới**, nhập **Hạn thanh toán của kỳ** → **Đồng bộ từ GitHub**.
   - Repo riêng tư: vào **Cài đặt** nhập GitHub token (chỉ cần quyền *Contents: Read*).
   - (Không bắt buộc) Tick *Tự tạo sẵn tài khoản cho Mã CTV mới* nếu muốn admin cấp mật khẩu thay vì để CTV tự đăng ký.
   - **Sửa kỳ thu cước**: vào mục **Kỳ thu cước** → bấm **✏️ Sửa** ở kỳ cần sửa. Sửa được:
     - **Tên kỳ** (khách thấy trong app và trong thông báo, biến `{ky}`).
     - **Hạn thanh toán**: chọn áp cho *thuê bao đang dùng hạn chung* (giữ nguyên thuê bao có hạn riêng) hoặc cho *tất cả thuê bao*.
     - **Ghi chú** và **đặt làm kỳ hiện tại** (khách và CTV sẽ chuyển sang xem kỳ đó).

     Trang này còn hiện thống kê từng kỳ: số thuê bao, tổng cước, đã thu, tiến độ, số thuê bao chưa có hạn. Xoá kỳ đang là kỳ hiện tại thì hệ thống tự chuyển sang kỳ mới nhất còn lại.
3. **CTV tự đăng ký trên app**: tab *Cộng tác viên* → **Đăng ký CTV** → nhập Mã CTV, họ tên, SĐT, mật khẩu → Gửi.
   Admin vào **Duyệt đăng ký** (menu có số đếm đơn chờ) → bấm **✓ Duyệt** hoặc **Từ chối** (kèm lý do). Mỗi đơn hiện:
   - số thuê bao của Mã CTV đó trong file cước (0 = có thể gõ sai mã);
   - cảnh báo nếu mã đã có người đang dùng (có thể là mạo danh – duyệt sẽ đổi mật khẩu người đang dùng).
   Duyệt xong CTV đăng nhập ngay bằng Mã CTV + mật khẩu đã tự đặt. Đăng nhập khi chưa duyệt sẽ báo "đang chờ duyệt"; bị từ chối sẽ thấy lý do.
   - Giữa kỳ có file cập nhật: chọn **Cập nhật vào kỳ hiện tại**. Trạng thái "đã thu" và tên/SĐT CTV đã nhập tay vẫn được giữ.
4. **CTV cài thông báo cho khách của mình**: trên app bấm **⚙️ Thông báo**, rồi:
   - **Nội dung thông báo**: sửa tự do, chạm để chèn Tên KH, Số TB, SĐT, Tổng cước, Địa bàn, Kỳ, Hạn. Để trống thì dùng nội dung chung của admin.
   - **Link nhóm Tammi** + tên nhóm: áp dụng cho **tất cả khách của CTV đó**. Cuối mỗi thông báo tự thêm dòng *"Vào nhóm Tammi để được biết thông tin và hỗ trợ kịp thời."* và nút **Vào nhóm Tammi**.
   - **Lịch hiển thị**: chọn *Từ ngày*, *Số lần*, *Cách nhau (ngày)*, các khung giờ đặt sẵn (07:00, 08:00, 11:30, 17:00, 19:30, 20:30) hoặc thêm giờ khác, rồi bấm **Đặt lịch**. Lịch đã đặt xoá được từng lần. Nút **Gửi thông báo ngay** dùng được tối đa 3 lần mỗi giờ.
   - Admin vẫn có nội dung, link nhóm và lịch **chung** (mục *Lịch thông báo* và *Cài đặt*), dùng cho CTV chưa tự cài.
5. **Khách vào app**: chỉ cần nhập **acc** (ví dụ `q055_gftth_abc` hoặc số thuê bao di động) **hoặc số điện thoại liên hệ** rồi bấm *Vào xem cước*. Cách khác là bấm link riêng CTV gửi (**📤 Gửi link**).
   - Nhập acc thì thấy đúng thuê bao đó. Nhập SĐT thì thấy các thuê bao có SĐT liên hệ đó.
   - **Khung nhắc cước hiện ngay** khi mở app, có nút ✕, *Bật thông báo* và *Vào nhóm Tammi*. Màn hình khách luôn có ô **Thông báo** với nội dung nhắc và lịch nhắc sắp tới.
   - Khách bật thông báo thì từ đó nhận nhắc đúng các giờ CTV đã đặt, kể cả khi không mở app.
   - Lưu ý: ai biết acc hoặc SĐT của khách cũng xem được cước của khách đó. Hệ thống giới hạn mỗi máy 8 lần nhập sai mỗi 15 phút và 20 lần tra cứu mỗi giờ để chặn dò hàng loạt.
6. CTV thu xong bấm **✓ Đã thu**. Khách đó sẽ không bị nhắc nữa.

### Tự cập nhật khách đã thanh toán (tiến độ thu)
- **Từ file cước mới**: đưa file cập nhật lên GitHub → *Nhập dữ liệu* → chọn **Cập nhật vào kỳ hiện tại** → Đồng bộ. Bật *Tự đồng bộ mỗi sáng* trong Cài đặt để không phải bấm tay. Thuê bao được **tự chuyển "Đã thu"** khi:
  - cột **Trạng thái** ghi "Đã thanh toán" / "Đã thu" / "x"; hoặc
  - có cột **Còn nợ** = 0; hoặc cột **Đã nộp** ≥ Tổng cước; hoặc
  - **Tổng cước** kỳ trước > 0 mà file mới = 0 (giữ số tiền cũ để thống kê "đã thu" đúng); hoặc
  - (tuỳ chọn, phải bật) thuê bao **không còn trong file mới**. Chỉ bật khi file là danh sách *còn nợ*. Nếu file mới có ít hơn 30% số thuê bao cũ (có thể chỉ là file một phần), hệ thống sẽ không tự đánh dấu.
- Trạng thái "đã thu" không bao giờ bị file mới đặt ngược lại thành "chưa thu".
- Danh sách *Thuê bao* ghi rõ ai đánh dấu đã thu: *tự động từ file*, *CTV …* hay *admin sửa*.
- Trang **Tổng quan** và **Kỳ thu cước** **tự làm mới mỗi 30 giây**: CTV bấm "Đã thu" là tiến độ tăng ngay.

### Nhóm hỗ trợ Tammi
Nút **Vào nhóm Tammi** chỉ hiện khi đã nhập link nhóm. Có 2 chỗ nhập:
- Admin: *Lịch thông báo* → ô **Link nhóm** ngay dưới nội dung thông báo. Áp dụng cho tất cả khách.
- Mỗi CTV: app → *⚙️ Thông báo* (riêng cho khách của CTV đó, ưu tiên hơn link chung).

Khi chưa có link, trang Tổng quan sẽ nhắc. Trong mẫu thông báo, `{han}` chỉ là ngày (15/11/2026), nên viết "trước ngày {han}". Chữ lặp như "tháng Tháng" sẽ được tự gộp.

**Tài khoản admin**: tạo tự động ở lần chạy đầu (tên `admin`, mật khẩu trong `data/MAT-KHAU-ADMIN-LAN-DAU.txt`). Admin không đăng ký qua app được. Muốn thêm admin khác: **Tài khoản CTV** → *Thêm tài khoản* → Vai trò *Quản trị*.

## 3. Phân quyền

- **CTV** đăng nhập bằng **Mã CTV** (ví dụ `DUOCNT_QNI_CNKD`) và mật khẩu, chỉ thấy thuê bao có đúng Mã CTV đó. CTV xem được Tên KH, Số TB, SĐT, Tổng cước, Tên địa bàn, Mã CTV, và nhập tay tên/SĐT còn thiếu. Phần nhập tay được nhớ cho các kỳ sau.
- **Khách hàng** chỉ thấy cước của thuê bao mình đã nhập (acc hoặc SĐT): Tên KH, Số TB, SĐT, Tổng cước, Tên địa bàn, kèm nội dung thông báo.
- **Nhật ký đăng nhập** ghi mọi lượt đăng nhập của CTV và khách: thời gian, thiết bị, IP, số thuê bao được cấp.

## 4. Đưa lên mạng để khách dùng thật (bắt buộc)

Thông báo trên điện thoại **chỉ hoạt động khi app chạy trên HTTPS** với tên miền thật. Ví dụ `https://nhaccuoc.ten-mien.vn`, không dùng được `http://192.168...`.

Cách đơn giản:
- **VPS** (Ubuntu): cài Node 22+, chạy `npm start` bằng `pm2`, đặt Caddy/Nginx phía trước để có HTTPS miễn phí (Let's Encrypt). Đặt biến `TRUST_PROXY=1`.
- Hoặc dịch vụ như Render / Railway / Fly.io. Cần ổ đĩa lưu bền cho thư mục `data/` (đặt `DATA_DIR` trỏ tới ổ đó).

Sau khi có tên miền: Quản trị → **Cài đặt** → *Địa chỉ web công khai* → nhập tên miền, để link gửi khách đúng địa chỉ. Cũng tại đây, nhập **link nhóm hỗ trợ** (ví dụ nhóm Zalo).

Biến môi trường (không bắt buộc): `PORT` (mặc định 3000), `DATA_DIR`, `ADMIN_PASSWORD` (mật khẩu admin lần đầu), `TRUST_PROXY`, `VAPID_SUBJECT` (ví dụ `mailto:email-cua-ban`).

**Sao lưu**: chỉ cần sao lưu thư mục `data/`. Không đưa thư mục này lên GitHub vì có dữ liệu khách và mật khẩu (đã có sẵn trong `.gitignore`).

## 5. Lưu ý về thông báo

- **Android (Chrome)**: bấm "Bật thông báo" là xong. Có thể bấm "Cài app vào điện thoại" để có biểu tượng trên màn hình chính.
- **iPhone (iOS 16.4+)**: phải mở link bằng Safari → nút **Chia sẻ** → **Thêm vào MH chính**, rồi mở app từ biểu tượng đó và bấm "Bật thông báo". App tự hiện hướng dẫn này cho khách dùng iPhone.
- Thông báo chỉ đến được máy đã bật thông báo. Màn hình Tổng quan hiện số khách đã cài app.
- Nếu máy chủ tắt vào giờ hẹn và bật lại sau hơn 6 tiếng, lịch đó được bỏ qua để không nhắn khách lúc nửa đêm.
