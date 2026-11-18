# Nhắc cước

App nhắc thanh toán cước cho **khách hàng** và công cụ thu cước cho **CTV**, kèm **trang quản trị**. Dữ liệu đầu kỳ lấy từ file Excel cước (tải lên hoặc đồng bộ từ GitHub).

- App điện thoại (khách & CTV): `/app/` – cài được lên màn hình chính (PWA), nhận thông báo nhắc cước.
- Trang quản trị: `/admin/`

Hướng dẫn sử dụng chi tiết: [HUONG-DAN.md](HUONG-DAN.md)

## Chạy trên máy

Cần Node.js 22.13 trở lên.

```bash
npm install
npm start
```

Mở http://localhost:3000/admin/ – mật khẩu `admin` lần đầu nằm trong `data/MAT-KHAU-ADMIN-LAN-DAU.txt` (hoặc đặt trước bằng biến `ADMIN_PASSWORD`).

## Đưa lên mạng (bắt buộc HTTPS để thông báo hoạt động)

### Cách 1 – Render (dễ nhất, tự cập nhật khi sửa code trên GitHub)
1. Đăng nhập https://render.com bằng tài khoản GitHub.
2. **New → Blueprint** → chọn repo này → Render đọc `render.yaml`.
3. Nhập `ADMIN_PASSWORD` (mật khẩu admin) và `VAPID_SUBJECT` (dạng `mailto:email-cua-ban@gmail.com`) → **Apply**.
4. Chờ build xong → mở `https://<tên-app>.onrender.com/admin/` → đăng nhập `admin`.
5. Quản trị → **Cài đặt** → *Địa chỉ web công khai* → nhập địa chỉ site để link gửi khách đúng.

> Gói có ổ đĩa (disk) để giữ dữ liệu là gói trả phí của Render. Gói miễn phí **xoá sạch dữ liệu** mỗi lần khởi động lại – không dùng cho thật.

### Cách 2 – Hostinger (Node.js web app)
1. Repo GitHub phải có đủ: `server.js`, `package.json`, `package-lock.json` **và các thư mục `src/`, `public/`, `scripts/`**.
2. Phiên bản Node.js: chọn **22** hoặc **24**. Entry file: `server.js`.
3. Biến môi trường:
   - `DATA_DIR` = `/home/<tài-khoản>/domains/<tên-miền>/nhaccuoc-data` (ngoài thư mục `hbuilds`, vì thư mục đó bị thay mới mỗi lần triển khai)
   - `TRUST_PROXY` = `1`, `ADMIN_PASSWORD`, `VAPID_SUBJECT`
   - **Không** đặt `PORT` – Hostinger tự cấp.
4. Bật SSL miễn phí cho tên miền (hPanel → Bảo mật → SSL) – thông báo điện thoại cần HTTPS.
5. Kiểm tra: mở `https://<tên-miền>/api/health` → thấy `"ok":true` là app đang chạy.

### Cách 3 – VPS / Docker
```bash
docker build -t nhac-thu-cuoc .
docker run -d --restart=always -p 3000:3000 -v /srv/nhac-cuoc-data:/data \
  -e ADMIN_PASSWORD=doi-mat-khau-nay -e VAPID_SUBJECT=mailto:email-cua-ban@gmail.com nhac-thu-cuoc
```
Đặt Caddy/Nginx phía trước để có HTTPS (Let's Encrypt).

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `PORT` | Cổng chạy (mặc định 3000) |
| `DATA_DIR` | Thư mục lưu CSDL – phải là ổ đĩa bền |
| `ADMIN_PASSWORD` | Mật khẩu `admin` lần chạy đầu |
| `VAPID_SUBJECT` | `mailto:email` liên hệ cho thông báo đẩy (iPhone yêu cầu hợp lệ) |
| `TRUST_PROXY` | `1` khi chạy sau Render/Nginx |

## Bảo mật

- **Không** đưa thư mục `data/` lên GitHub (đã có trong `.gitignore`): chứa dữ liệu khách hàng, mật khẩu, khoá thông báo.
- Để repo ở chế độ **Private**. File Excel cước trên GitHub cũng nên nằm trong repo riêng tư (nhập token đọc trong *Cài đặt*).
- Sao lưu định kỳ thư mục dữ liệu (`DATA_DIR`).
