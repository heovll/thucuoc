// Máy chủ: API + trang quản trị (/admin) + app điện thoại cho khách hàng & CTV (/app).
const path = require('node:path');
const express = require('express');
const ExcelJS = require('exceljs');
const { db, getSetting, setSetting, tx } = require('./src/db');
const auth = require('./src/auth');
const { parseWorkbook, importRows, coverage, sampleWorkbook, toYMD, toMoney, cleanPhone, cleanSubscriber } = require('./src/excel');
const { downloadFromGithub, parseGithubUrl } = require('./src/github');
const notify = require('./src/notify');
const { normKey, todayVN, nowVN, addDays, splitAreas, renderTemplate } = require('./src/util');

const PORT = Number(process.env.PORT || 3000);
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});

auth.ensureAdmin();
const VAPID_PUBLIC = notify.initVapid();

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Mã không hợp lệ.');
  return id;
};
const remindDays = () => Math.max(0, parseInt(getSetting('remind_days_before'), 10) || 0);
function logLogin(req, { userId = null, username, client, success, reason = '', count = null }) {
  db.prepare('INSERT INTO login_logs(user_id, username, client, success, reason, ip, user_agent, customer_count) VALUES(?,?,?,?,?,?,?,?)').run(
    userId, String(username).slice(0, 80), client, success ? 1 : 0, reason, req.ip || '', String(req.headers['user-agent'] || '').slice(0, 300), count
  );
}

// ================================================================ ĐĂNG NHẬP
// CTV (bằng Mã CTV) và quản trị viên
app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const client = req.body?.client === 'admin' ? 'admin' : 'ctv';
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (auth.tooManyFailures(key)) {
    logLogin(req, { username, client, success: false, reason: 'Bị khoá tạm do sai nhiều lần' });
    return res.status(429).json({ error: 'Sai mật khẩu quá nhiều lần. Thử lại sau 15 phút.' });
  }
  const user =
    db.prepare('SELECT * FROM users WHERE username = ?').get(username) ||
    db.prepare("SELECT * FROM users WHERE staff_code <> '' AND staff_code = ? COLLATE NOCASE").get(username);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    // Đang có đơn đăng ký với đúng mật khẩu → báo trạng thái đơn thay vì "sai mật khẩu"
    const reg = db
      .prepare("SELECT * FROM registrations WHERE staff_code = ? COLLATE NOCASE AND status IN ('cho','tu_choi') ORDER BY id DESC LIMIT 1")
      .get(username);
    if (reg && auth.verifyPassword(password, reg.password_hash)) {
      logLogin(req, { username, client, success: false, reason: reg.status === 'cho' ? 'Đăng ký chờ duyệt' : 'Đăng ký bị từ chối' });
      return res.status(403).json({
        error: reg.status === 'cho'
          ? 'Tài khoản đang chờ quản trị viên duyệt. Vui lòng quay lại sau.'
          : `Đăng ký đã bị từ chối${reg.note ? ': ' + reg.note : ''}. Liên hệ quản trị viên.`,
      });
    }
    auth.noteFailure(key);
    logLogin(req, { userId: user?.id, username, client, success: false, reason: user ? 'Sai mật khẩu' : 'Không có tài khoản' });
    return res.status(401).json({ error: 'Sai Mã CTV / tên đăng nhập hoặc mật khẩu.' });
  }
  if (!user.active) {
    logLogin(req, { userId: user.id, username, client, success: false, reason: 'Tài khoản bị khoá' });
    return res.status(403).json({ error: 'Tài khoản đã bị khoá. Liên hệ quản trị viên.' });
  }
  if (client === 'admin' && user.role !== 'admin') {
    logLogin(req, { userId: user.id, username, client, success: false, reason: 'Không có quyền quản trị' });
    return res.status(403).json({ error: 'Tài khoản này không có quyền quản trị.' });
  }
  auth.failures.delete(key);
  // Phân tích tài khoản → số thuê bao được cấp ở kỳ hiện tại (theo Mã CTV)
  const period = auth.currentPeriod();
  let count = 0;
  if (period) {
    const sc = auth.customerScope(user);
    count = db.prepare(`SELECT COUNT(*) n FROM customers c WHERE c.period_id = ? AND ${sc.sql}`).get(period.id, ...sc.params).n;
  }
  logLogin(req, { userId: user.id, username: user.username, client, success: true, count });
  res.json({ token: auth.createSession(user.id), kind: 'user', user: auth.publicUser(user), customerCount: count });
});

// CTV tự đăng ký trên app → chờ admin duyệt
const regHits = new Map(); // giới hạn 5 đơn / giờ / IP
app.post('/api/register', (req, res) => {
  const now = Date.now();
  const hits = (regHits.get(req.ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= 5) return res.status(429).json({ error: 'Gửi đăng ký quá nhiều lần. Thử lại sau 1 giờ.' });
  const b = req.body || {};
  const code = String(b.staff_code || '').trim().toUpperCase();
  const fullName = String(b.full_name || '').trim().slice(0, 80);
  const phone = cleanPhone(b.phone);
  const pw = String(b.password || '');
  if (!/^[A-Z0-9._-]{3,40}$/.test(code)) throw badRequest('Mã CTV không hợp lệ (chỉ gồm chữ không dấu, số, dấu _ . -).');
  if (!fullName) throw badRequest('Vui lòng nhập họ tên.');
  if (!phone) throw badRequest('Số điện thoại không hợp lệ.');
  if (pw.length < 6) throw badRequest('Mật khẩu phải từ 6 ký tự.');
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND (username = ? COLLATE NOCASE OR staff_code = ? COLLATE NOCASE)").get(code, code))
    throw badRequest('Mã này không dùng để đăng ký được.');
  if (db.prepare("SELECT 1 FROM registrations WHERE staff_code = ? AND status = 'cho'").get(code))
    throw badRequest('Mã CTV này đã có đơn đăng ký đang chờ duyệt. Liên hệ quản trị viên nếu cần sửa.');
  hits.push(now);
  regHits.set(req.ip, hits);
  db.prepare('INSERT INTO registrations(staff_code, full_name, phone, password_hash, ip, user_agent) VALUES(?,?,?,?,?,?)').run(
    code, fullName, phone, auth.hashPassword(pw), req.ip || '', String(req.headers['user-agent'] || '').slice(0, 300)
  );
  res.json({ ok: true });
});

// Khách hàng: nhập acc (Số TB) HOẶC số điện thoại → thấy đúng thuê bao của mình.
// Chống dò hàng loạt: mỗi IP tối đa 8 lần sai / 15 phút và 20 lần tra cứu thành công / giờ.
const lookupHits = new Map();
app.post('/api/customer/login', (req, res) => {
  const raw = String(req.body?.tra_cuu ?? req.body?.so_tb ?? '').trim();
  const key = `${req.ip}|kh`;
  if (auth.tooManyFailures(key)) return res.status(429).json({ error: 'Nhập sai quá nhiều lần. Thử lại sau 15 phút.' });
  const now = Date.now();
  const hits = (lookupHits.get(req.ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= 20) return res.status(429).json({ error: 'Tra cứu quá nhiều lần. Thử lại sau 1 giờ.' });
  if (!raw) throw badRequest('Nhập acc (Số thuê bao) hoặc số điện thoại.');
  const period = auth.currentPeriod();
  if (!period) return res.status(503).json({ error: 'Hệ thống chưa có dữ liệu cước kỳ này. Vui lòng thử lại sau.' });

  // 1) Khớp Số TB / acc (thuê bao di động: Số TB chính là SĐT)
  const tbKey = normKey(cleanSubscriber(raw));
  const byTb = tbKey ? db.prepare('SELECT COUNT(*) n FROM customers WHERE period_id = ? AND ma_kh_key = ?').get(period.id, tbKey).n : 0;
  // 2) Không có → khớp SĐT liên hệ
  const phone = byTb ? '' : cleanPhone(raw);
  const byPhone = phone ? db.prepare('SELECT COUNT(*) n FROM customers WHERE period_id = ? AND sdt = ?').get(period.id, phone).n : 0;
  if (!byTb && !byPhone) {
    auth.noteFailure(key);
    logLogin(req, { username: raw.slice(0, 60), client: 'khach', success: false, reason: 'Không tìm thấy acc/SĐT' });
    return res.status(401).json({ error: 'Không tìm thấy thuê bao. Kiểm tra lại acc hoặc số điện thoại.' });
  }
  hits.push(now);
  lookupHits.set(req.ip, hits);
  const token = byTb ? auth.createCustomerSession(tbKey, '') : auth.createCustomerSession(null, '', phone);
  logLogin(req, { username: raw.slice(0, 60), client: 'khach', success: true, reason: byTb ? 'theo acc' : 'theo SĐT', count: byTb || byPhone });
  res.json({ token, kind: 'customer' });
});

// ---------------------------------------------------------------- Link riêng cho khách
// Khách bấm link CTV gửi (…/app/#k=TOKEN) là vào thẳng cước của mình.
const crypto = require('node:crypto');
function linkTokensFor(rows) {
  const get = db.prepare('SELECT token FROM customer_links WHERE ma_kh_key = ? AND ma_hd = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO customer_links(token, ma_kh_key, ma_hd) VALUES(?,?,?)');
  const out = new Map();
  tx(() => {
    for (const r of rows) {
      if (!r.ma_kh_key) continue;
      let t = get.get(r.ma_kh_key, r.ma_hd || '')?.token;
      if (!t) {
        t = crypto.randomBytes(12).toString('base64url');
        ins.run(t, r.ma_kh_key, r.ma_hd || '');
      }
      out.set(r.id, t);
    }
  });
  return out;
}
const baseUrl = (req) => (getSetting('public_url') || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const customerLink = (req, token) => `${baseUrl(req)}/app/#k=${token}`;

app.post('/api/customer/link', (req, res) => {
  const k = String(req.body?.k || '').trim();
  const key = `${req.ip}|link`;
  if (auth.tooManyFailures(key)) return res.status(429).json({ error: 'Thử lại sau 15 phút.' });
  const l = /^[A-Za-z0-9_-]{10,40}$/.test(k) && db.prepare('SELECT * FROM customer_links WHERE token = ?').get(k);
  if (!l) {
    auth.noteFailure(key);
    logLogin(req, { username: '(link sai)', client: 'khach', success: false, reason: 'Link không hợp lệ' });
    return res.status(401).json({ error: 'Link không còn hiệu lực. Liên hệ CTV phụ trách để được gửi lại.' });
  }
  const token = auth.createCustomerSession(l.ma_kh_key, l.ma_hd);
  logLogin(req, { username: l.ma_kh_key, client: 'khach', success: true, reason: 'qua link', count: 1 });
  res.json({ token, kind: 'customer' });
});

app.post('/api/logout', (req, res) => {
  const t = auth.getToken(req);
  if (t) {
    db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(String(req.body?.endpoint || ''));
    auth.destroySession(t);
  }
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const s = auth.sessionFromToken(auth.getToken(req));
  if (!s) return res.status(401).json({ error: 'Chưa đăng nhập.' });
  const period = auth.currentPeriod();
  if (s.kind === 'customer') return res.json({ kind: 'customer', period });
  res.json({ kind: 'user', user: auth.publicUser(s.user), period });
});

app.post('/api/me/password', auth.requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!auth.verifyPassword(String(oldPassword || ''), req.user.password_hash)) throw badRequest('Mật khẩu cũ không đúng.');
  if (String(newPassword || '').length < 6) throw badRequest('Mật khẩu mới phải từ 6 ký tự.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(newPassword), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, auth.getToken(req));
  res.json({ ok: true });
});

// ================================================================ APP KHÁCH HÀNG
// Khách chỉ thấy: Tên KH, Số TB, SĐT liên hệ, Tổng cước, Tên địa bàn (+ hạn, trạng thái)
app.get('/api/customer/me', auth.requireCustomer, (req, res) => {
  const period = auth.currentPeriod();
  if (!period) return res.json({ period: null, bills: [] });
  const bills = notify.customerBills(req.cust, period).map((c) => ({
    ten_kh: c.ten_kh, so_tb: c.ma_kh, sdt: c.sdt, tong_cuoc: c.so_tien, dia_ban: c.dia_ban,
    han_tt: c.han_tt, da_thanh_toan: c.trang_thai === 'da_thu', ngay_thu: c.ngay_thu,
  }));
  const all = notify.customerBills(req.cust, period);
  const st = all.length ? notify.notifySettingsFor(all[0]) : { supportUrl: getSetting('support_url'), supportName: getSetting('support_name') };
  // Lịch nhắc sắp tới: lịch chung của admin + lịch CTV phụ trách tự đặt
  const upcoming = db
    .prepare(
      `SELECT send_at FROM schedules WHERE status='cho' AND send_at >= ?
         AND ((owner_id IS NULL AND target IN ('khach','ca_hai')) OR owner_id = ?)
       ORDER BY send_at LIMIT 5`
    )
    .all(nowVN(), st.ctvId || -1)
    .map((r) => r.send_at);
  // Nội dung thông báo hiện ngay trên màn hình khách (chỉ khi còn khoản chưa thanh toán)
  const unpaid = all.filter((c) => c.trang_thai === 'chua_thu');
  const msg = notify.customerMessage(unpaid, period);
  res.json({
    period: { name: period.name },
    today: todayVN(),
    bills,
    nextReminder: upcoming[0] || null,
    upcoming,
    reminder: msg ? { title: msg.title, body: msg.body } : null,
    support: st.supportUrl ? { url: st.supportUrl, name: st.supportName } : null,
  });
});

// ================================================================ APP CTV
// CTV thấy thêm Mã CTV; chỉ thuê bao đúng Mã CTV của mình
const CUS_FIELDS = 'c.id, c.ma_kh, c.ma_hd, c.ten_kh, c.sdt, c.dia_chi, c.dia_ban, c.ma_nv, c.dich_vu, c.so_tien, c.han_tt, c.trang_thai, c.ngay_thu, c.ghi_chu, c.paid_source';

app.get('/api/my/customers', auth.requireAuth, (req, res) => {
  const period = auth.currentPeriod();
  if (!period) return res.json({ period: null, customers: [] });
  const sc = auth.customerScope(req.user);
  const customers = db
    .prepare(`SELECT ${CUS_FIELDS} FROM customers c WHERE c.period_id = ? AND ${sc.sql} ORDER BY c.trang_thai, c.dia_ban, c.ten_kh = '', c.ten_kh`)
    .all(period.id, ...sc.params);
  const links = linkTokensFor(
    db.prepare(`SELECT c.id, c.ma_kh_key, c.ma_hd FROM customers c WHERE c.period_id = ? AND ${sc.sql}`).all(period.id, ...sc.params)
  );
  for (const c of customers) c.link = links.has(c.id) ? customerLink(req, links.get(c.id)) : '';
  res.json({
    period: { id: period.id, name: period.name }, today: todayVN(), remindDays: remindDays(),
    smsTemplate: getSetting('sms_template'), customers,
    support: { url: getSetting('support_url'), name: getSetting('support_name') || 'Nhóm hỗ trợ' },
  });
});

app.post('/api/my/customers/:id', auth.requireAuth, (req, res) => {
  const id = idParam(req);
  const sc = auth.customerScope(req.user);
  const c = db.prepare(`SELECT c.* FROM customers c WHERE c.id = ? AND ${sc.sql}`).get(id, ...sc.params);
  if (!c) return res.status(404).json({ error: 'Không tìm thấy thuê bao (hoặc không thuộc Mã CTV của bạn).' });
  const b = req.body || {};
  if (b.trang_thai && !['da_thu', 'chua_thu'].includes(b.trang_thai)) throw badRequest('Trạng thái không hợp lệ.');
  const status = b.trang_thai || c.trang_thai;
  const note = b.ghi_chu !== undefined ? String(b.ghi_chu).slice(0, 500) : c.ghi_chu;
  // CTV nhập tay Tên / SĐT cho thuê bao thiếu thông tin
  const ten = b.ten_kh !== undefined ? String(b.ten_kh).trim().slice(0, 120) : c.ten_kh;
  let sdt = c.sdt;
  if (b.sdt !== undefined) {
    sdt = cleanPhone(b.sdt);
    if (String(b.sdt).trim() && !sdt) throw badRequest('Số điện thoại không hợp lệ.');
  }
  tx(() => {
    const changedStatus = status !== c.trang_thai;
    db.prepare(`UPDATE customers SET ten_kh=?, sdt=?, trang_thai=?, ngay_thu=?, thu_boi=?, ghi_chu=?, paid_source=?, updated_at=datetime('now') WHERE id=?`).run(
      ten, sdt, status, status === 'da_thu' ? c.ngay_thu || todayVN() : null,
      status === 'da_thu' ? (changedStatus ? req.user.id : c.thu_boi) : null, note,
      status === 'da_thu' ? (changedStatus ? 'ctv' : c.paid_source) : '', id
    );
    if ((ten !== c.ten_kh || sdt !== c.sdt) && c.ma_kh_key) {
      db.prepare(
        `INSERT INTO customer_overrides(ma_kh_key, ten_kh, sdt, updated_by) VALUES(?,?,?,?)
         ON CONFLICT(ma_kh_key) DO UPDATE SET ten_kh=excluded.ten_kh, sdt=excluded.sdt, updated_by=excluded.updated_by, updated_at=datetime('now')`
      ).run(c.ma_kh_key, ten, sdt, req.user.id);
    }
  });
  const out = db.prepare(`SELECT ${CUS_FIELDS} FROM customers c WHERE c.id = ?`).get(id);
  const t = linkTokensFor([c]).get(c.id);
  out.link = t ? customerLink(req, t) : '';
  res.json(out);
});

// ---------------------------------------------------------------- CTV: cài đặt thông báo cho khách của mình
// Nội dung + link nhóm (Tammi) + lịch hiển thị. Áp dụng cho toàn bộ thuê bao có Mã CTV của CTV này.
function ctvNotifyInfo(user) {
  const own = db.prepare('SELECT * FROM ctv_settings WHERE user_id = ?').get(user.id) || {};
  const period = auth.currentPeriod();
  const sc = auth.customerScope(user);
  const sample = period
    ? db.prepare(`SELECT c.* FROM customers c WHERE c.period_id = ? AND ${sc.sql} AND c.trang_thai='chua_thu' ORDER BY c.ten_kh = '', c.sdt = '' LIMIT 1`).get(period.id, ...sc.params)
    : null;
  return {
    customer_template: own.customer_template || '',
    support_url: own.support_url || '',
    support_name: own.support_name || '',
    defaults: {
      customer_template: getSetting('customer_template'),
      support_url: getSetting('support_url'),
      support_name: getSetting('support_name'),
      support_line: getSetting('support_line'),
    },
    sample,
    periodName: period?.name || '',
    now: nowVN(),
    schedules: db.prepare("SELECT * FROM schedules WHERE owner_id = ? ORDER BY status = 'cho' DESC, send_at LIMIT 200").all(user.id),
    devices: period
      ? db.prepare(`SELECT COUNT(DISTINCT p.id) n FROM push_subs p JOIN customers c ON c.period_id = ? AND ${sc.sql}
                     AND ((p.cust_key IS NOT NULL AND c.ma_kh_key = p.cust_key) OR (p.cust_phone IS NOT NULL AND c.sdt = p.cust_phone))`)
          .get(period.id, ...sc.params).n
      : 0,
  };
}
const requireStaff = (req, res, next) => auth.requireAuth(req, res, () => {
  if (req.user.role !== 'staff' && req.user.role !== 'admin') return res.status(403).json({ error: 'Không có quyền.' });
  next();
});
app.get('/api/my/notify', requireStaff, (req, res) => res.json(ctvNotifyInfo(req.user)));
app.put('/api/my/notify', requireStaff, (req, res) => {
  const b = req.body || {};
  const url = String(b.support_url || '').trim();
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw badRequest('Link nhóm phải bắt đầu bằng http:// hoặc https://');
  db.prepare(
    `INSERT INTO ctv_settings(user_id, customer_template, support_url, support_name) VALUES(?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET customer_template=excluded.customer_template, support_url=excluded.support_url,
       support_name=excluded.support_name, updated_at=datetime('now')`
  ).run(req.user.id, String(b.customer_template || '').trim().slice(0, 500), url, String(b.support_name || '').trim().slice(0, 60));
  res.json(ctvNotifyInfo(req.user));
});
app.post('/api/my/notify/preview', requireStaff, (req, res) => {
  const info = ctvNotifyInfo(req.user);
  const c = info.sample || { ten_kh: 'Nguyễn Văn A', ma_kh: 'q055_gftth_vidu', sdt: '0912345678', so_tien: 180000, dia_ban: 'Thôn 1', han_tt: todayVN() };
  const b = req.body || {};
  const main = renderTemplate(String(b.customer_template || '').trim() || info.defaults.customer_template, c, info.periodName || 'Tháng này');
  const url = String(b.support_url || '').trim() || info.defaults.support_url;
  const name = String(b.support_name || '').trim() || info.defaults.support_name;
  const line = url ? info.defaults.support_line.replace(/\{nhom\}/g, name) : '';
  res.json({ body: line ? `${main}\n${line}` : main, support: url ? { url, name } : null });
});
app.post('/api/my/schedules', requireStaff, (req, res) => {
  const list = Array.isArray(req.body?.times) ? req.body.times : [];
  if (!list.length) throw badRequest('Chọn ít nhất 1 thời điểm.');
  if (list.length > 60) throw badRequest('Tối đa 60 lần mỗi lần thêm.');
  const times = [...new Set(list.map(parseSendAt))];
  const now = nowVN();
  if (times.some((t) => t < now.slice(0, 16))) throw badRequest('Có thời điểm đã qua – chọn ngày giờ trong tương lai.');
  const pending = db.prepare("SELECT COUNT(*) n FROM schedules WHERE owner_id = ? AND status = 'cho'").get(req.user.id).n;
  if (pending + times.length > 120) throw badRequest('Bạn đã có quá nhiều lịch chờ gửi (tối đa 120).');
  const exists = db.prepare("SELECT 1 FROM schedules WHERE owner_id = ? AND send_at = ? AND status = 'cho'");
  const ins = db.prepare("INSERT INTO schedules(send_at, target, message, owner_id) VALUES(?, 'khach', '', ?)");
  let added = 0;
  tx(() => times.forEach((t) => { if (!exists.get(req.user.id, t)) { ins.run(t, req.user.id); added++; } }));
  res.json({ added, skipped: times.length - added });
});
app.delete('/api/my/schedules/:id', requireStaff, (req, res) => {
  const r = db.prepare("DELETE FROM schedules WHERE id = ? AND owner_id = ? AND status = 'cho'").run(idParam(req), req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Không tìm thấy lịch.' });
  res.json({ ok: true });
});
// Gửi ngay cho khách của mình (giới hạn 3 lần / giờ để tránh làm phiền khách)
const sendNowHits = new Map();
app.post('/api/my/notify/send-now', requireStaff, async (req, res) => {
  const now = Date.now();
  const hits = (sendNowHits.get(req.user.id) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= 3) return res.status(429).json({ error: 'Chỉ được gửi ngay tối đa 3 lần mỗi giờ.' });
  hits.push(now);
  sendNowHits.set(req.user.id, hits);
  const r = await notify.sendToCustomers({ ownerId: req.user.id });
  db.prepare("INSERT INTO schedules(send_at, target, message, owner_id, status, sent_at, result) VALUES(?, 'khach', '', ?, 'da_gui', ?, ?)").run(
    nowVN(), req.user.id, nowVN(), `Gửi ngay: ${r.sent}/${r.devices} thiết bị (bỏ qua ${r.paidSkipped} đã thanh toán)`
  );
  res.json(r);
});

// ================================================================ THÔNG BÁO ĐẨY
app.get('/api/push/key', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));
app.post('/api/push/subscribe', (req, res) => {
  const sess = auth.sessionFromToken(auth.getToken(req));
  if (!sess) return res.status(401).json({ error: 'Chưa đăng nhập.' });
  const s = req.body?.subscription;
  if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth || !/^https:\/\//.test(s.endpoint)) throw badRequest('Đăng ký thông báo không hợp lệ.');
  const userId = sess.kind === 'user' ? sess.user.id : null;
  const custKey = sess.kind === 'customer' ? sess.custKey || null : null;
  const custHd = sess.kind === 'customer' ? sess.custHd : null;
  const custPhone = sess.kind === 'customer' ? sess.custPhone || null : null;
  db.prepare(
    `INSERT INTO push_subs(user_id, cust_key, cust_hd, cust_phone, endpoint, p256dh, auth) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, cust_key=excluded.cust_key, cust_hd=excluded.cust_hd,
       cust_phone=excluded.cust_phone, p256dh=excluded.p256dh, auth=excluded.auth`
  ).run(userId, custKey, custHd, custPhone, s.endpoint, s.keys.p256dh, s.keys.auth);
  res.json({ ok: true });
});
app.post('/api/push/test', async (req, res) => {
  const sess = auth.sessionFromToken(auth.getToken(req));
  if (!sess) return res.status(401).json({ error: 'Chưa đăng nhập.' });
  const sub = db.prepare('SELECT * FROM push_subs WHERE endpoint = ?').get(String(req.body?.endpoint || ''));
  if (!sub) throw badRequest('Thiết bị này chưa bật thông báo.');
  let msg;
  const period = auth.currentPeriod();
  if (sess.kind === 'customer' && period) msg = notify.customerMessage(notify.customerBills(sess, period), period);
  if (sess.kind === 'user') msg = notify.ctvMessage(notify.ctvSummary(sess.user));
  msg ||= { title: 'Nhắc cước', body: 'Thông báo đã hoạt động trên thiết bị này.', url: '/app/', tag: 'thu' };
  res.json({ sent: (await notify.pushTo(sub, msg)) ? 1 : 0 });
});

// ================================================================ QUẢN TRỊ
const admin = express.Router();
admin.use(auth.requireAdmin);
const periodOf = (req) =>
  (Number(req.query.period_id) && db.prepare('SELECT * FROM periods WHERE id = ?').get(Number(req.query.period_id))) || auth.currentPeriod();

admin.get('/dashboard', (req, res) => {
  const period = periodOf(req);
  const today = todayVN();
  const days = remindDays();
  const staffCount = db.prepare("SELECT COUNT(*) n FROM users WHERE role='staff' AND active=1").get().n;
  const logins = db
    .prepare(
      `SELECT SUM(CASE WHEN success=1 AND client='ctv' THEN 1 ELSE 0 END) ctv, SUM(CASE WHEN success=1 AND client='khach' THEN 1 ELSE 0 END) khach,
        SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) fail FROM login_logs WHERE date(at,'+7 hours') = ?`
    )
    .get(today);
  const devices = db
    .prepare('SELECT COUNT(DISTINCT cust_key) khach, COUNT(DISTINCT user_id) ctv FROM push_subs')
    .get();
  const nextSchedule = db.prepare("SELECT * FROM schedules WHERE status='cho' ORDER BY send_at LIMIT 1").get() || null;
  const pendingRegs = db.prepare("SELECT COUNT(*) n FROM registrations WHERE status='cho'").get().n;
  const supportSet = !!getSetting('support_url') || !!db.prepare("SELECT 1 FROM ctv_settings WHERE support_url <> ''").get();
  if (!period) return res.json({ period: null, staffCount, logins, devices, nextSchedule, pendingRegs, supportSet });

  const agg = (where, params = []) =>
    db
      .prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(so_tien),0) tien,
          SUM(CASE WHEN trang_thai='da_thu' THEN 1 ELSE 0 END) n_thu,
          COALESCE(SUM(CASE WHEN trang_thai='da_thu' THEN so_tien END),0) tien_thu,
          SUM(CASE WHEN trang_thai='chua_thu' AND han_tt < ? THEN 1 ELSE 0 END) qua_han,
          SUM(CASE WHEN trang_thai='chua_thu' AND han_tt >= ? AND han_tt <= ? THEN 1 ELSE 0 END) sap_den,
          SUM(CASE WHEN ten_kh = '' THEN 1 ELSE 0 END) thieu_ten,
          SUM(CASE WHEN sdt = '' THEN 1 ELSE 0 END) thieu_sdt
         FROM customers c WHERE c.period_id = ? ${where ? 'AND ' + where : ''}`
      )
      .get(today, today, addDays(today, days), period.id, ...params);

  const total = agg('');
  const byArea = db
    .prepare(
      `SELECT dia_ban, COUNT(*) n, SUM(so_tien) tien, SUM(CASE WHEN trang_thai='da_thu' THEN so_tien ELSE 0 END) tien_thu,
         COUNT(DISTINCT ma_nv_key) so_ctv
       FROM customers WHERE period_id = ? GROUP BY dia_ban_key ORDER BY n DESC`
    )
    .all(period.id);
  const staff = db.prepare("SELECT * FROM users WHERE role='staff' ORDER BY staff_code, username").all();
  const byStaff = staff.map((u) => {
    const sc = auth.customerScope(u);
    const last = db.prepare('SELECT at FROM login_logs WHERE user_id=? AND success=1 ORDER BY id DESC LIMIT 1').get(u.id);
    const dev = db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id=?').get(u.id).n;
    return { id: u.id, username: u.username, full_name: u.full_name, staff_code: u.staff_code, active: !!u.active, ...agg(sc.sql, sc.params), last_login: last?.at || null, devices: dev };
  });
  res.json({ period, today, remindDays: days, total, byArea, byStaff, coverage: coverage(period.id), staffCount, logins, devices, nextSchedule, pendingRegs, supportSet });
});

// --- Kỳ cước
// Danh sách kỳ kèm thống kê thu
admin.get('/periods', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT p.*,
           COUNT(c.id) n,
           COALESCE(SUM(c.so_tien), 0) tien,
           SUM(CASE WHEN c.trang_thai = 'da_thu' THEN 1 ELSE 0 END) n_thu,
           COALESCE(SUM(CASE WHEN c.trang_thai = 'da_thu' THEN c.so_tien END), 0) tien_thu,
           COUNT(DISTINCT CASE WHEN c.ma_nv_key <> '' THEN c.ma_nv_key END) so_ctv,
           SUM(CASE WHEN c.han_tt IS NULL THEN 1 ELSE 0 END) khong_han,
           SUM(CASE WHEN c.han_tt IS NOT NULL AND c.han_tt <> COALESCE(p.default_due, '') THEN 1 ELSE 0 END) han_rieng
         FROM periods p LEFT JOIN customers c ON c.period_id = p.id
         GROUP BY p.id ORDER BY p.id DESC`
      )
      .all()
  );
});
admin.post('/periods/:id/current', (req, res) => {
  const id = idParam(req);
  if (!db.prepare('SELECT 1 FROM periods WHERE id = ?').get(id)) return res.status(404).json({ error: 'Không tìm thấy kỳ.' });
  tx(() => {
    db.prepare('UPDATE periods SET is_current = 0').run();
    db.prepare('UPDATE periods SET is_current = 1 WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
/**
 * Sửa kỳ thu cước: tên kỳ, hạn thanh toán, ghi chú, đặt làm kỳ hiện tại.
 * due_scope: 'chung' (mặc định) → chỉ đổi hạn cho thuê bao đang dùng hạn chung cũ / chưa có hạn;
 *            'tat_ca' → đặt hạn mới cho toàn bộ thuê bao trong kỳ (kể cả thuê bao có hạn riêng).
 */
admin.put('/periods/:id', (req, res) => {
  const id = idParam(req);
  const p = db.prepare('SELECT * FROM periods WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Không tìm thấy kỳ.' });
  const b = req.body || {};
  const name = String(b.name ?? p.name).trim().slice(0, 60);
  if (!name) throw badRequest('Tên kỳ không được trống.');
  if (name !== p.name && db.prepare('SELECT 1 FROM periods WHERE name = ? AND id <> ?').get(name, id)) throw badRequest('Đã có kỳ khác trùng tên này.');
  let due = p.default_due;
  if (b.default_due !== undefined) {
    due = b.default_due ? toYMD(b.default_due) : null;
    if (b.default_due && !due) throw badRequest('Hạn thanh toán không hợp lệ.');
  }
  const note = b.note !== undefined ? String(b.note).trim().slice(0, 300) : p.note || '';
  let changed = 0;
  tx(() => {
    if (b.due_scope === 'tat_ca') {
      changed = db.prepare('UPDATE customers SET han_tt = ? WHERE period_id = ? AND han_tt IS NOT ?').run(due, id, due).changes;
    } else if (due !== p.default_due) {
      changed = db
        .prepare('UPDATE customers SET han_tt = ? WHERE period_id = ? AND (han_tt IS NULL OR han_tt = ?)')
        .run(due, id, p.default_due || '').changes;
    }
    db.prepare("UPDATE periods SET name = ?, default_due = ?, note = ?, updated_at = datetime('now') WHERE id = ?").run(name, due, note, id);
    if (b.make_current) {
      db.prepare('UPDATE periods SET is_current = 0').run();
      db.prepare('UPDATE periods SET is_current = 1 WHERE id = ?').run(id);
    }
  });
  res.json({ ok: true, changed });
});
admin.delete('/periods/:id', (req, res) => {
  const id = idParam(req);
  const p = db.prepare('SELECT * FROM periods WHERE id = ?').get(id);
  if (!p) return res.status(404).json({ error: 'Không tìm thấy kỳ.' });
  let newCurrent = null;
  tx(() => {
    db.prepare('DELETE FROM periods WHERE id = ?').run(id);
    // Xoá kỳ hiện tại → tự chuyển sang kỳ mới nhất còn lại để app không bị trống
    if (p.is_current) {
      newCurrent = db.prepare('SELECT * FROM periods ORDER BY id DESC LIMIT 1').get() || null;
      if (newCurrent) db.prepare('UPDATE periods SET is_current = 1 WHERE id = ?').run(newCurrent.id);
    }
  });
  res.json({ ok: true, newCurrent: newCurrent ? { id: newCurrent.id, name: newCurrent.name } : null });
});

// --- Thuê bao
admin.get('/filters', (req, res) => {
  const period = periodOf(req);
  if (!period) return res.json({ areas: [], staff: [] });
  res.json({
    areas: db.prepare("SELECT DISTINCT dia_ban v FROM customers WHERE period_id=? AND dia_ban<>'' ORDER BY dia_ban").all(period.id).map((r) => r.v),
    staff: db.prepare("SELECT DISTINCT ma_nv v FROM customers WHERE period_id=? AND ma_nv<>'' ORDER BY ma_nv").all(period.id).map((r) => r.v),
  });
});
admin.get('/customers', (req, res) => {
  const period = periodOf(req);
  if (!period) return res.json({ rows: [], total: 0 });
  const today = todayVN();
  const where = ['c.period_id = ?'];
  const params = [period.id];
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push('(c.ma_kh LIKE ? OR c.ma_hd LIKE ? OR c.ten_kh LIKE ? OR c.sdt LIKE ?)');
    params.push(...Array(4).fill(`%${q}%`));
  }
  if (req.query.dia_ban) { where.push('c.dia_ban_key = ?'); params.push(normKey(req.query.dia_ban)); }
  if (req.query.ma_nv) { where.push('c.ma_nv_key = ?'); params.push(normKey(req.query.ma_nv)); }
  const st = req.query.status;
  if (st === 'da_thu' || st === 'chua_thu') { where.push('c.trang_thai = ?'); params.push(st); }
  if (st === 'qua_han') { where.push("c.trang_thai='chua_thu' AND c.han_tt < ?"); params.push(today); }
  if (st === 'thieu_ten') where.push("c.ten_kh = ''");
  if (st === 'thieu_sdt') where.push("c.sdt = ''");
  const w = where.join(' AND ');
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
  const page = Math.max(1, Number(req.query.page) || 1);
  const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(so_tien),0) tien FROM customers c WHERE ${w}`).get(...params);
  const rows = db
    .prepare(
      `SELECT ${CUS_FIELDS}, u.username thu_boi_ten FROM customers c LEFT JOIN users u ON u.id = c.thu_boi
       WHERE ${w} ORDER BY c.ma_nv, c.dia_ban, c.ten_kh = '', c.ten_kh LIMIT ? OFFSET ?`
    )
    .all(...params, limit, (page - 1) * limit);
  res.json({ rows, total: total.n, totalMoney: total.tien, page, limit, period, today });
});
function customerFromBody(b) {
  const ma = cleanSubscriber(b.ma_kh);
  if (!ma) throw badRequest('Cần nhập Số TB.');
  const han = b.han_tt ? toYMD(b.han_tt) : null;
  if (b.han_tt && !han) throw badRequest('Hạn thanh toán không hợp lệ.');
  const st = b.trang_thai === 'da_thu' ? 'da_thu' : 'chua_thu';
  return {
    ma_kh: ma, ma_hd: String(b.ma_hd || '').trim(), ten_kh: String(b.ten_kh || '').trim(), sdt: cleanPhone(b.sdt),
    dia_ban: String(b.dia_ban || '').trim(), ma_nv: String(b.ma_nv || '').trim(), dich_vu: String(b.dich_vu || '').trim(),
    so_tien: toMoney(b.so_tien), han_tt: han, trang_thai: st, ghi_chu: String(b.ghi_chu || '').trim(),
  };
}
admin.post('/customers', (req, res) => {
  const period = auth.currentPeriod();
  if (!period) throw badRequest('Chưa có kỳ cước. Hãy nhập file đầu kỳ trước.');
  const c = customerFromBody(req.body || {});
  const r = db
    .prepare(`INSERT INTO customers(period_id, ma_kh, ma_kh_key, ma_hd, ten_kh, sdt, dia_ban, dia_ban_key, ma_nv, ma_nv_key, dich_vu, so_tien, han_tt, trang_thai, ngay_thu, ghi_chu)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(period.id, c.ma_kh, normKey(c.ma_kh), c.ma_hd, c.ten_kh, c.sdt, c.dia_ban, normKey(c.dia_ban), c.ma_nv, normKey(c.ma_nv),
      c.dich_vu, c.so_tien, c.han_tt || period.default_due, c.trang_thai, c.trang_thai === 'da_thu' ? todayVN() : null, c.ghi_chu);
  res.json({ id: Number(r.lastInsertRowid) });
});
admin.put('/customers/:id', (req, res) => {
  const id = idParam(req);
  const old = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!old) return res.status(404).json({ error: 'Không tìm thấy thuê bao.' });
  const c = customerFromBody(req.body || {});
  db.prepare(`UPDATE customers SET ma_kh=?, ma_kh_key=?, ma_hd=?, ten_kh=?, sdt=?, dia_ban=?, dia_ban_key=?, ma_nv=?, ma_nv_key=?, dich_vu=?,
              so_tien=?, han_tt=?, trang_thai=?, ngay_thu=?, ghi_chu=?, paid_source=?, updated_at=datetime('now') WHERE id=?`)
    .run(c.ma_kh, normKey(c.ma_kh), c.ma_hd, c.ten_kh, c.sdt, c.dia_ban, normKey(c.dia_ban), c.ma_nv, normKey(c.ma_nv), c.dich_vu,
      c.so_tien, c.han_tt, c.trang_thai, c.trang_thai === 'da_thu' ? old.ngay_thu || todayVN() : null, c.ghi_chu,
      c.trang_thai === 'da_thu' ? (old.trang_thai === 'da_thu' ? old.paid_source : 'admin') : '', id);
  if ((c.ten_kh !== old.ten_kh || c.sdt !== old.sdt) && normKey(c.ma_kh))
    db.prepare(
      `INSERT INTO customer_overrides(ma_kh_key, ten_kh, sdt, updated_by) VALUES(?,?,?,?)
       ON CONFLICT(ma_kh_key) DO UPDATE SET ten_kh=excluded.ten_kh, sdt=excluded.sdt, updated_by=excluded.updated_by, updated_at=datetime('now')`
    ).run(normKey(c.ma_kh), c.ten_kh, c.sdt, req.user.id);
  res.json({ ok: true });
});
admin.delete('/customers/:id', (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(idParam(req));
  res.json({ ok: true });
});

// --- Tài khoản CTV
function userFromBody(b, isNew) {
  const u = {
    username: String(b.username || '').trim(),
    full_name: String(b.full_name || '').trim(),
    role: b.role === 'admin' ? 'admin' : 'staff',
    staff_code: String(b.staff_code ?? '').trim(),
    areas: splitAreas(b.areas).join(', '),
    phone: String(b.phone || '').trim(),
    active: b.active === false || b.active === 0 ? 0 : 1,
    password: b.password ? String(b.password) : '',
  };
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(u.username)) throw badRequest('Tên đăng nhập 3–40 ký tự, chỉ gồm chữ không dấu, số, dấu . _ -');
  if ((isNew || u.password) && u.password.length < 6) throw badRequest('Mật khẩu phải từ 6 ký tự.');
  return u;
}
admin.get('/users', (req, res) => {
  const period = auth.currentPeriod();
  const users = db.prepare('SELECT * FROM users ORDER BY role, staff_code, username').all();
  res.json(
    users.map((u) => {
      let count = 0;
      if (period) {
        const sc = auth.customerScope(u);
        count = db.prepare(`SELECT COUNT(*) n FROM customers c WHERE c.period_id=? AND ${sc.sql}`).get(period.id, ...sc.params).n;
      }
      const last = db.prepare('SELECT at FROM login_logs WHERE user_id=? AND success=1 ORDER BY id DESC LIMIT 1').get(u.id);
      const devices = db.prepare('SELECT COUNT(*) n FROM push_subs WHERE user_id=?').get(u.id).n;
      return { ...auth.publicUser(u), customer_count: count, last_login: last?.at || null, devices };
    })
  );
});
admin.post('/users', (req, res) => {
  const u = userFromBody(req.body || {}, true);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) throw badRequest('Tên đăng nhập đã tồn tại.');
  const r = db
    .prepare('INSERT INTO users(username, password_hash, full_name, role, staff_code, areas, phone, active) VALUES(?,?,?,?,?,?,?,?)')
    .run(u.username, auth.hashPassword(u.password), u.full_name, u.role, u.staff_code, u.areas, u.phone, u.active);
  res.json({ id: Number(r.lastInsertRowid) });
});
admin.put('/users/:id', (req, res) => {
  const id = idParam(req);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  const u = userFromBody(req.body || {}, false);
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(u.username, id)) throw badRequest('Tên đăng nhập đã tồn tại.');
  if (id === req.user.id && (u.role !== 'admin' || !u.active)) throw badRequest('Không thể tự bỏ quyền quản trị hoặc tự khoá tài khoản của mình.');
  db.prepare('UPDATE users SET username=?, full_name=?, role=?, staff_code=?, areas=?, phone=?, active=? WHERE id=?').run(
    u.username, u.full_name, u.role, u.staff_code, u.areas, u.phone, u.active, id
  );
  if (u.password) db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(u.password), id);
  if (u.password || !u.active) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(id, auth.getToken(req));
  res.json({ ok: true });
});
admin.post('/users/:id/reset-password', (req, res) => {
  const id = idParam(req);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  const pw = auth.randomPassword();
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(pw), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(id, auth.getToken(req));
  res.json({ username: u.username, password: pw });
});
admin.delete('/users/:id', (req, res) => {
  const id = idParam(req);
  if (id === req.user.id) throw badRequest('Không thể xoá chính mình.');
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Duyệt đăng ký CTV
admin.get('/registrations', (req, res) => {
  const period = auth.currentPeriod();
  const status = ['cho', 'duyet', 'tu_choi'].includes(req.query.status) ? req.query.status : 'cho';
  const rows = db
    .prepare(`SELECT r.id, r.staff_code, r.full_name, r.phone, r.status, r.note, r.ip, r.user_agent, r.created_at, r.decided_at, u.username decided_by_name
              FROM registrations r LEFT JOIN users u ON u.id = r.decided_by WHERE r.status = ? ORDER BY r.id DESC LIMIT 200`)
    .all(status);
  // Phân tích từng đơn: Mã CTV có trong file cước không, đã có tài khoản đang dùng chưa
  for (const r of rows) {
    r.customer_count = period
      ? db.prepare('SELECT COUNT(*) n FROM customers WHERE period_id = ? AND ma_nv_key = ?').get(period.id, normKey(r.staff_code)).n
      : 0;
    const u = db.prepare('SELECT id, username, full_name, phone, active FROM users WHERE staff_code = ? COLLATE NOCASE OR username = ? COLLATE NOCASE').get(r.staff_code, r.staff_code);
    r.existing = u
      ? { ...u, last_login: db.prepare('SELECT at FROM login_logs WHERE user_id=? AND success=1 ORDER BY id DESC LIMIT 1').get(u.id)?.at || null }
      : null;
  }
  res.json({ rows, pending: db.prepare("SELECT COUNT(*) n FROM registrations WHERE status='cho'").get().n });
});
admin.post('/registrations/:id/approve', (req, res) => {
  const r = db.prepare("SELECT * FROM registrations WHERE id = ? AND status = 'cho'").get(idParam(req));
  if (!r) return res.status(404).json({ error: 'Không tìm thấy đơn đang chờ duyệt.' });
  const u = db.prepare('SELECT * FROM users WHERE staff_code = ? COLLATE NOCASE OR username = ? COLLATE NOCASE').get(r.staff_code, r.staff_code);
  if (u?.role === 'admin') throw badRequest('Mã này trùng tài khoản quản trị – không thể duyệt.');
  tx(() => {
    if (u) {
      // Đã có tài khoản (vd tạo tự động khi nhập file) → cập nhật mật khẩu/thông tin theo đơn, đăng xuất phiên cũ
      db.prepare('UPDATE users SET password_hash=?, full_name=?, phone=?, staff_code=?, active=1 WHERE id=?').run(
        r.password_hash, r.full_name, r.phone, u.staff_code || r.staff_code, u.id
      );
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    } else {
      db.prepare("INSERT INTO users(username, password_hash, full_name, role, staff_code, phone) VALUES(?,?,?,'staff',?,?)").run(
        r.staff_code, r.password_hash, r.full_name, r.staff_code, r.phone
      );
    }
    db.prepare("UPDATE registrations SET status='duyet', decided_at=datetime('now'), decided_by=? WHERE id=?").run(req.user.id, r.id);
  });
  res.json({ ok: true });
});
admin.post('/registrations/:id/reject', (req, res) => {
  const note = String(req.body?.note || '').trim().slice(0, 200);
  const r = db
    .prepare("UPDATE registrations SET status='tu_choi', note=?, decided_at=datetime('now'), decided_by=? WHERE id=? AND status='cho'")
    .run(note, req.user.id, idParam(req));
  if (!r.changes) return res.status(404).json({ error: 'Không tìm thấy đơn đang chờ duyệt.' });
  res.json({ ok: true });
});

// --- Nhật ký đăng nhập
admin.get('/login-logs', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.client) { where.push('l.client = ?'); params.push(String(req.query.client)); }
  if (req.query.user_id) { where.push('l.user_id = ?'); params.push(Number(req.query.user_id)); }
  if (req.query.result === 'ok') where.push('l.success = 1');
  if (req.query.result === 'fail') where.push('l.success = 0');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const page = Math.max(1, Number(req.query.page) || 1);
  const total = db.prepare(`SELECT COUNT(*) n FROM login_logs l ${w}`).get(...params).n;
  const rows = db.prepare(`SELECT l.* FROM login_logs l ${w} ORDER BY l.id DESC LIMIT 50 OFFSET ?`).all(...params, (page - 1) * 50);
  const perUser = db
    .prepare(
      `SELECT u.id, u.username, u.staff_code, u.role,
         SUM(CASE WHEN l.success=1 THEN 1 ELSE 0 END) ok, SUM(CASE WHEN l.success=0 THEN 1 ELSE 0 END) fail,
         MAX(CASE WHEN l.success=1 THEN l.at END) last_ok,
         COUNT(DISTINCT CASE WHEN l.success=1 THEN date(l.at,'+7 hours') END) days_active
       FROM users u LEFT JOIN login_logs l ON l.user_id = u.id AND l.at >= datetime('now','-30 days')
       GROUP BY u.id ORDER BY last_ok IS NULL, last_ok DESC`
    )
    .all();
  const customers = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN success=1 THEN username END) tb, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) ok,
        SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) fail FROM login_logs WHERE client='khach' AND at >= datetime('now','-30 days')`
    )
    .get();
  res.json({ rows, total, page, perUser, customers });
});

// --- Lịch gửi thông báo
const TARGETS = ['khach', 'ctv', 'ca_hai'];
function parseSendAt(s) {
  const m = String(s || '').trim().replace('T', ' ').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) throw badRequest('Thời gian gửi không hợp lệ.');
  const d = new Date(m[1] + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== m[1]) throw badRequest('Ngày gửi không hợp lệ.');
  return `${m[1]} ${m[2]}:${m[3]}`;
}
admin.get('/schedules', (req, res) => {
  res.json({
    now: nowVN(),
    rows: db
      .prepare(`SELECT s.*, u.staff_code owner_code, u.username owner_name FROM schedules s LEFT JOIN users u ON u.id = s.owner_id
                ORDER BY s.status = 'cho' DESC, s.send_at DESC LIMIT 300`)
      .all(),
  });
});
admin.post('/schedules', (req, res) => {
  const b = req.body || {};
  const target = TARGETS.includes(b.target) ? b.target : 'khach';
  const list = Array.isArray(b.times) ? b.times : [b.send_at];
  if (!list.length || list.length > 60) throw badRequest('Số mốc gửi không hợp lệ.');
  const times = list.map(parseSendAt);
  const ins = db.prepare('INSERT INTO schedules(send_at, target, message) VALUES(?,?,?)');
  tx(() => times.forEach((t) => ins.run(t, target, String(b.message || '').slice(0, 500))));
  res.json({ ok: true, added: times.length });
});
admin.put('/schedules/:id', (req, res) => {
  const id = idParam(req);
  const b = req.body || {};
  db.prepare("UPDATE schedules SET send_at=?, target=?, message=? WHERE id=? AND status='cho'").run(
    parseSendAt(b.send_at), TARGETS.includes(b.target) ? b.target : 'khach', String(b.message || '').slice(0, 500), id
  );
  res.json({ ok: true });
});
admin.delete('/schedules/:id', (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(idParam(req));
  res.json({ ok: true });
});
admin.post('/schedules/:id/run', async (req, res) => {
  const sch = db.prepare('SELECT * FROM schedules WHERE id = ?').get(idParam(req));
  if (!sch) return res.status(404).json({ error: 'Không tìm thấy lịch.' });
  const result = await notify.runSchedule(sch);
  db.prepare("UPDATE schedules SET status='da_gui', sent_at=?, result=? WHERE id=?").run(nowVN(), result, sch.id);
  res.json({ result });
});
admin.post('/notify-preview', (req, res) => {
  const period = auth.currentPeriod();
  const sample = (period &&
    db.prepare("SELECT * FROM customers WHERE period_id=? AND ten_kh<>'' AND sdt<>'' AND trang_thai='chua_thu' LIMIT 1").get(period.id)) || {
    ten_kh: 'Nguyễn Văn A', ma_kh: '0912345678', sdt: '0912345678', so_tien: 180000, dia_ban: 'Thôn 1', han_tt: todayVN(),
  };
  const main = renderTemplate(req.body?.message || getSetting('customer_template'), sample, period?.name || 'Tháng này');
  // xem trước theo link nhóm đang gõ (chưa lưu); không gửi thì dùng link đã lưu
  const supportUrl = req.body?.support_url !== undefined ? String(req.body.support_url).trim() : getSetting('support_url');
  const supportName = String(req.body?.support_name || '').trim() || getSetting('support_name') || 'nhóm Tammi';
  const st = { supportUrl: /^https?:\/\/\S+$/i.test(supportUrl) ? supportUrl : '', supportName };
  const line = notify.supportLine(st);
  res.json({ body: line ? `${main}\n${line}` : main, support: st.supportUrl ? { url: st.supportUrl, name: supportName } : null });
});

// --- Cài đặt
admin.get('/settings', (req, res) => {
  res.json({
    github_url: getSetting('github_url'),
    github_token_set: !!getSetting('github_token'),
    auto_sync: getSetting('auto_sync') === '1',
    auto_mark_paid: getSetting('auto_mark_paid') === '1',
    remind_days_before: Number(getSetting('remind_days_before')),
    remind_hour: Number(getSetting('remind_hour')),
    ctv_daily: getSetting('ctv_daily') === '1',
    customer_template: getSetting('customer_template'),
    sms_template: getSetting('sms_template'),
    support_url: getSetting('support_url'),
    support_name: getSetting('support_name'),
    public_url: getSetting('public_url'),
    detected_url: `${req.protocol}://${req.get('host')}`,
    last_sync_date: getSetting('last_sync_date'),
  });
});
admin.put('/settings', (req, res) => {
  const b = req.body || {};
  if (b.github_url !== undefined) {
    if (b.github_url) parseGithubUrl(b.github_url);
    setSetting('github_url', String(b.github_url).trim());
  }
  if (b.github_token) setSetting('github_token', String(b.github_token).trim());
  if (b.clear_github_token) setSetting('github_token', '');
  if (b.auto_sync !== undefined) setSetting('auto_sync', b.auto_sync ? '1' : '0');
  if (b.auto_mark_paid !== undefined) setSetting('auto_mark_paid', b.auto_mark_paid ? '1' : '0');
  if (b.ctv_daily !== undefined) setSetting('ctv_daily', b.ctv_daily ? '1' : '0');
  if (b.remind_days_before !== undefined) setSetting('remind_days_before', Math.min(30, Math.max(0, parseInt(b.remind_days_before, 10) || 0)));
  if (b.remind_hour !== undefined) setSetting('remind_hour', Math.min(22, Math.max(5, parseInt(b.remind_hour, 10) || 8)));
  if (b.customer_template !== undefined) setSetting('customer_template', String(b.customer_template).slice(0, 500));
  if (b.sms_template !== undefined) setSetting('sms_template', String(b.sms_template).slice(0, 500));
  if (b.support_name !== undefined) setSetting('support_name', String(b.support_name).trim().slice(0, 60) || 'Nhóm hỗ trợ');
  for (const k of ['support_url', 'public_url']) {
    if (b[k] === undefined) continue;
    const v = String(b[k]).trim();
    if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw badRequest('Link phải bắt đầu bằng http:// hoặc https://');
    setSetting(k, k === 'public_url' ? v.replace(/\/+$/, '') : v);
  }
  res.json({ ok: true });
});

// --- Nhập dữ liệu
async function doImport(buffer, source, opts) {
  const parsed = await parseWorkbook(buffer);
  const result = importRows(parsed, { ...opts, source, hashPassword: auth.hashPassword, randomPassword: auth.randomPassword });
  result.coverage = coverage(result.period.id);
  return result;
}
function importOpts(src) {
  const defaultDue = src.defaultDue ? toYMD(src.defaultDue) : null;
  if (src.defaultDue && !defaultDue) throw badRequest('Hạn thanh toán không hợp lệ.');
  return {
    mode: src.mode === 'update' ? 'update' : 'new',
    periodName: String(src.periodName || '').trim(),
    defaultDue,
    createAccounts: src.createAccounts === true || src.createAccounts === '1',
    markMissingPaid: src.markMissingPaid === true || src.markMissingPaid === '1',
  };
}
admin.post('/import/github', async (req, res) => {
  const url = String(req.body?.url || getSetting('github_url') || '').trim();
  if (!url) throw badRequest('Chưa nhập link file Excel trên GitHub.');
  const opts = importOpts(req.body || {});
  const file = await downloadFromGithub(url, getSetting('github_token'));
  if (req.body?.url) setSetting('github_url', url);
  res.json(await doImport(file.buffer, file.source, opts));
});
admin.post('/import/upload', express.raw({ type: () => true, limit: '30mb' }), async (req, res) => {
  if (!req.body?.length) throw badRequest('Chưa chọn file.');
  const name = String(req.query.filename || 'tai-len.xlsx').slice(0, 200);
  res.json(await doImport(req.body, `upload:${name}`, importOpts(req.query)));
});
admin.get('/sample.xlsx', async (req, res) => {
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="mau-file-cuoc.xlsx"');
  res.send(Buffer.from(await sampleWorkbook()));
});
admin.get('/export.xlsx', async (req, res) => {
  const period = periodOf(req);
  if (!period) throw badRequest('Chưa có kỳ cước.');
  const rows = db
    .prepare(`SELECT c.*, u.username thu_boi_ten FROM customers c LEFT JOIN users u ON u.id=c.thu_boi WHERE c.period_id=? ORDER BY c.ma_nv, c.dia_ban, c.ten_kh`)
    .all(period.id);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('KetQuaThu');
  ws.columns = [
    { header: 'Tên KH', key: 'ten_kh', width: 26 }, { header: 'Số TB', key: 'ma_kh', width: 22 },
    { header: 'Số ĐT liên hệ', key: 'sdt', width: 14 }, { header: 'Tổng cước', key: 'so_tien', width: 12, style: { numFmt: '#,##0' } },
    { header: 'Tên địa bàn', key: 'dia_ban', width: 34 }, { header: 'Mã CTV', key: 'ma_nv', width: 20 },
    { header: 'Mã hợp đồng', key: 'ma_hd', width: 14 }, { header: 'Loại thuê bao', key: 'dich_vu', width: 14 },
    { header: 'Hạn thanh toán', key: 'han', width: 15, style: { numFmt: 'dd/mm/yyyy' } }, { header: 'Trạng thái', key: 'tt', width: 12 },
    { header: 'Ngày thu', key: 'nt', width: 12, style: { numFmt: 'dd/mm/yyyy' } }, { header: 'CTV cập nhật', key: 'thu_boi_ten', width: 20 },
    { header: 'Ghi chú', key: 'ghi_chu', width: 24 }, { header: 'Link khách', key: 'link', width: 50 },
  ];
  ws.getRow(1).font = { bold: true };
  const d = (s) => (s ? new Date(s + 'T00:00:00Z') : null);
  const links = linkTokensFor(rows);
  for (const r of rows)
    ws.addRow({ ...r, han: d(r.han_tt), nt: d(r.ngay_thu), tt: r.trang_thai === 'da_thu' ? 'Đã thu' : 'Chưa thu', link: links.has(r.id) ? customerLink(req, links.get(r.id)) : '' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="ket-qua-thu-cuoc-${period.id}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

app.use('/api/admin', admin);

// ================================================================ GIAO DIỆN
const pub = path.join(__dirname, 'public');
const noCache = (res, p) => {
  if (/\.(html|js|webmanifest|css)$/.test(p)) res.set('Cache-Control', 'no-cache');
};
app.use('/app', express.static(path.join(pub, 'app'), { setHeaders: noCache }));
app.use('/admin', express.static(path.join(pub, 'admin'), { setHeaders: noCache }));
app.use('/shared', express.static(path.join(pub, 'shared'), { setHeaders: noCache }));
app.get('/', (req, res) => res.redirect('/app/'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Không có API này.' }));
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Lỗi máy chủ.' });
});

// Tự đồng bộ GitHub hằng ngày (nếu bật) → cập nhật vào kỳ hiện tại, giữ trạng thái đã thu
async function autoSync() {
  const file = await downloadFromGithub(getSetting('github_url'), getSetting('github_token'));
  const r = await doImport(file.buffer, file.source, {
    mode: 'update', createAccounts: false, markMissingPaid: getSetting('auto_mark_paid') === '1',
  });
  console.log(`Tự đồng bộ GitHub: +${r.inserted} mới, ${r.updated} cập nhật, tự đánh dấu đã thu ${r.autoPaid + r.autoPaidMissing} TB.`);
}
notify.startScheduler({ autoSync });

app.listen(PORT, () => {
  console.log(`Máy chủ chạy tại http://localhost:${PORT}`);
  console.log(`  • App khách hàng & CTV: http://localhost:${PORT}/app/`);
  console.log(`  • Trang quản trị:       http://localhost:${PORT}/admin/`);
});
