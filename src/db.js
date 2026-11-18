// Cơ sở dữ liệu SQLite tích hợp sẵn trong Node (node:sqlite) – không cần cài thêm.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (e) {
  console.error(
    `\n[LỖI] Không tạo/ghi được thư mục dữ liệu DATA_DIR="${DATA_DIR}" (${e.code || e.message}).\n` +
    '      → Đặt DATA_DIR là thư mục bạn có quyền ghi và KHÔNG bị xoá khi triển khai lại,\n' +
    '        vd trên Hostinger: /home/<tài-khoản>/domains/<tên-miền>/nhaccuoc-data\n'
  );
  process.exit(1);
}
console.log(`Thư mục dữ liệu: ${DATA_DIR}`);

const db = new DatabaseSync(path.join(DATA_DIR, 'nhac-thu-cuoc.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  staff_code TEXT NOT NULL DEFAULT '',
  areas TEXT NOT NULL DEFAULT '',          -- danh sách địa bàn, cách nhau bằng dấu phẩy
  phone TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phiên đăng nhập: của CTV/admin (user_id) hoặc của khách hàng (cust_key = Số TB chuẩn hoá)
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  cust_key TEXT,
  cust_hd TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',         -- 'app' hoặc 'admin'
  success INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  customer_count INTEGER,                  -- số KH được cấp cho user ở lần đăng nhập này
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  default_due TEXT,                        -- hạn mặc định nếu file không có cột hạn
  is_current INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
  ma_kh TEXT NOT NULL DEFAULT '',          -- Số TB
  ma_kh_key TEXT NOT NULL DEFAULT '',
  ma_hd TEXT NOT NULL DEFAULT '',          -- Mã hợp đồng
  ten_kh TEXT NOT NULL DEFAULT '',
  sdt TEXT NOT NULL DEFAULT '',
  dia_chi TEXT NOT NULL DEFAULT '',
  dia_ban TEXT NOT NULL DEFAULT '',
  dia_ban_key TEXT NOT NULL DEFAULT '',
  ma_nv TEXT NOT NULL DEFAULT '',
  ma_nv_key TEXT NOT NULL DEFAULT '',
  dich_vu TEXT NOT NULL DEFAULT '',
  so_tien INTEGER NOT NULL DEFAULT 0,
  han_tt TEXT,                             -- YYYY-MM-DD
  trang_thai TEXT NOT NULL DEFAULT 'chua_thu' CHECK (trang_thai IN ('chua_thu','da_thu')),
  ngay_thu TEXT,
  thu_boi INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ghi_chu TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cus_period ON customers(period_id);
CREATE INDEX IF NOT EXISTS idx_cus_nv ON customers(period_id, ma_nv_key);
CREATE INDEX IF NOT EXISTS idx_cus_area ON customers(period_id, dia_ban_key);
CREATE INDEX IF NOT EXISTS idx_cus_tb ON customers(period_id, ma_kh_key);

-- Thiết bị nhận thông báo: của CTV (user_id) hoặc của khách hàng (cust_key)
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  cust_key TEXT,
  cust_hd TEXT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Lịch gửi thông báo do admin chỉ định
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  send_at TEXT NOT NULL,                   -- 'YYYY-MM-DD HH:MM' giờ Việt Nam
  target TEXT NOT NULL DEFAULT 'khach' CHECK (target IN ('khach','ctv','ca_hai')),
  message TEXT NOT NULL DEFAULT '',        -- để trống = dùng mẫu chung
  status TEXT NOT NULL DEFAULT 'cho' CHECK (status IN ('cho','da_gui','loi')),
  sent_at TEXT,
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tên / SĐT do CTV nhập tay cho thuê bao thiếu thông tin – giữ qua các kỳ, ghép theo Số TB
CREATE TABLE IF NOT EXISTS customer_overrides (
  ma_kh_key TEXT PRIMARY KEY,
  ten_kh TEXT NOT NULL DEFAULT '',
  sdt TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Link riêng cho từng thuê bao: khách bấm link là vào thẳng, không phải nhập gì. Giữ nguyên qua các kỳ.
CREATE TABLE IF NOT EXISTS customer_links (
  token TEXT PRIMARY KEY,
  ma_kh_key TEXT NOT NULL,
  ma_hd TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ma_kh_key, ma_hd)
);

-- CTV tự đăng ký trên app, chờ admin duyệt
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_code TEXT NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'cho' CHECK (status IN ('cho','duyet','tu_choi')),
  note TEXT NOT NULL DEFAULT '',           -- lý do từ chối
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_status ON registrations(status, staff_code);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Cài đặt thông báo riêng của từng CTV (áp dụng cho toàn bộ khách của CTV đó)
db.exec(`
CREATE TABLE IF NOT EXISTS ctv_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  customer_template TEXT NOT NULL DEFAULT '',
  support_url TEXT NOT NULL DEFAULT '',
  support_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Nâng cấp CSDL cũ: thêm cột nếu chưa có (giữ nguyên dữ liệu đang dùng)
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('sessions', 'cust_phone', 'TEXT');       // khách vào bằng SĐT → thấy các thuê bao có SĐT đó
addColumn('push_subs', 'cust_phone', 'TEXT');
addColumn('schedules', 'owner_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE'); // NULL = lịch chung của admin
addColumn('periods', 'note', "TEXT NOT NULL DEFAULT ''");     // ghi chú kỳ thu cước
addColumn('customers', 'paid_source', "TEXT NOT NULL DEFAULT ''"); // ai đánh dấu đã thu: ctv | admin | file
addColumn('periods', 'updated_at', 'TEXT');

const DEFAULT_SETTINGS = {
  github_url: '',
  github_token: '',
  auto_sync: '0',
  remind_days_before: '3',
  remind_hour: '8',
  ctv_daily: '1',                          // nhắc CTV tóm tắt mỗi sáng
  customer_template:
    'Kính gửi {ten} - Số TB {sotb} - SĐT {sdt}. Tổng cước {ky}: {sotien}đ. Địa bàn: {diaban}. Quý khách vui lòng thanh toán trước ngày {han}. Xin cảm ơn!',
  sms_template:
    'Kinh gui {ten} - So TB {sotb}. Tong cuoc {ky}: {sotien}d. Dia ban: {diaban}. Vui long thanh toan truoc ngay {han}. Xem cuoc va nhan nhac tai: {link}',
  support_url: '',                         // link nhóm hỗ trợ (nhóm Tammi)
  support_name: 'nhóm Tammi',
  // dòng tự thêm cuối mỗi thông báo khi có link nhóm
  support_line: 'Vào {nhom} để được biết thông tin và hỗ trợ kịp thời.',
  public_url: '',                          // địa chỉ web công khai, vd https://nhaccuoc.example.vn (trống = tự lấy)
  last_notify_date: '',
  last_sync_date: '',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key] ?? '';
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, DATA_DIR, getSetting, setSetting, tx };
