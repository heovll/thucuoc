// Đăng nhập, phiên làm việc và phân quyền dữ liệu.
//  - CTV / admin: tài khoản trong bảng users (CTV đăng nhập bằng Mã CTV).
//  - Khách hàng: đăng nhập bằng Số TB + (Mã hợp đồng hoặc SĐT liên hệ), không cần tài khoản.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('./db');
const { normKey, splitAreas } = require('./util');

const SESSION_DAYS = 60;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
// Mật khẩu ngẫu nhiên dễ đọc (bỏ ký tự dễ nhầm 0/O, 1/l)
function randomPassword(len = 8) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(len), (b) => chars[b % chars.length]).join('');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function expiry() {
  return new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
}
function createSession(userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)').run(token, userId, expiry());
  return token;
}
// Phiên khách: theo Số TB (custKey) hoặc theo SĐT (custPhone → mọi thuê bao có SĐT đó)
function createCustomerSession(custKey, custHd, custPhone) {
  const token = newToken();
  db.prepare('INSERT INTO sessions(token, cust_key, cust_hd, cust_phone, expires_at) VALUES(?,?,?,?,?)').run(
    token, custKey || null, custHd || '', custPhone || null, expiry()
  );
  return token;
}
function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function sessionFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?').get(token, new Date().toISOString());
  if (!s) return null;
  if (s.user_id) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(s.user_id);
    return u ? { kind: 'user', user: u } : null;
  }
  if (s.cust_key || s.cust_phone) return { kind: 'customer', custKey: s.cust_key || '', custHd: s.cust_hd || '', custPhone: s.cust_phone || '' };
  return null;
}

// Chống dò mật khẩu: tối đa 8 lần sai / 15 phút cho mỗi khoá (IP + tên đăng nhập).
const failures = new Map();
function tooManyFailures(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) {
    failures.delete(key);
    return false;
  }
  return f.count >= 8;
}
function noteFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}

function getToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
const unauthorized = (res) => res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.' });

function requireAuth(req, res, next) {
  const s = sessionFromToken(getToken(req));
  if (!s || s.kind !== 'user') return unauthorized(res);
  req.user = s.user;
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Chỉ quản trị viên được dùng chức năng này.' });
    next();
  });
}
function requireCustomer(req, res, next) {
  const s = sessionFromToken(getToken(req));
  if (!s || s.kind !== 'customer') return unauthorized(res);
  req.cust = s;
  next();
}

/**
 * Điều kiện lọc khách hàng theo tài khoản đăng nhập.
 * CTV thấy khách hàng nếu cột "Mã CTV" khớp Mã CTV của tài khoản,
 * hoặc "Tên địa bàn" thuộc các địa bàn được giao thêm (nếu admin có giao).
 * Admin thấy toàn bộ.
 */
function customerScope(user, alias = 'c') {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  const nvKeys = [normKey(user.staff_code)].filter(Boolean);
  const areaKeys = splitAreas(user.areas).map(normKey).filter(Boolean);
  const parts = [];
  const params = [];
  if (nvKeys.length) {
    parts.push(`${alias}.ma_nv_key IN (${nvKeys.map(() => '?').join(',')})`);
    params.push(...nvKeys);
  }
  if (areaKeys.length) {
    parts.push(`${alias}.dia_ban_key IN (${areaKeys.map(() => '?').join(',')})`);
    params.push(...areaKeys);
  }
  if (!parts.length) return { sql: '1=0', params: [] };
  return { sql: `(${parts.join(' OR ')})`, params };
}

/** Điều kiện lọc cho phiên khách hàng: đúng Số TB (+ Mã HĐ nếu vào qua link), hoặc đúng SĐT liên hệ. */
function customerSelfScope(cust, alias = 'c') {
  if (cust.custPhone && !cust.custKey) return { sql: `${alias}.sdt = ?`, params: [cust.custPhone] };
  if (cust.custHd) return { sql: `(${alias}.ma_kh_key = ? AND ${alias}.ma_hd = ?)`, params: [cust.custKey, cust.custHd] };
  return { sql: `${alias}.ma_kh_key = ?`, params: [cust.custKey] };
}

function currentPeriod() {
  return db.prepare('SELECT * FROM periods WHERE is_current = 1 ORDER BY id DESC LIMIT 1').get() || null;
}

// Tạo tài khoản quản trị lần đầu chạy.
function ensureAdmin() {
  const n = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n;
  if (n > 0) return;
  const pw = process.env.ADMIN_PASSWORD || randomPassword(10);
  db.prepare("INSERT INTO users(username, password_hash, full_name, role) VALUES('admin', ?, 'Quản trị viên', 'admin')").run(
    hashPassword(pw)
  );
  if (!process.env.ADMIN_PASSWORD) {
    const f = path.join(DATA_DIR, 'MAT-KHAU-ADMIN-LAN-DAU.txt');
    fs.writeFileSync(
      f,
      `Tài khoản quản trị đầu tiên\nTên đăng nhập: admin\nMật khẩu: ${pw}\n\nHãy đổi mật khẩu trong trang quản trị (mục Tài khoản CTV) rồi xoá file này.\n`
    );
    console.log(`[!] Đã tạo tài khoản quản trị "admin". Mật khẩu lưu tại: ${f}`);
  }
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    role: u.role,
    staff_code: u.staff_code,
    areas: u.areas,
    phone: u.phone,
    active: !!u.active,
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  randomPassword,
  createSession,
  createCustomerSession,
  destroySession,
  sessionFromToken,
  getToken,
  requireAuth,
  requireAdmin,
  requireCustomer,
  customerScope,
  customerSelfScope,
  currentPeriod,
  ensureAdmin,
  publicUser,
  tooManyFailures,
  noteFailure,
  failures,
};
