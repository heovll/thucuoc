// Thông báo đẩy (Web Push): lịch nhắc khách hàng do admin chỉ định + tóm tắt hằng ngày cho CTV.
const webpush = require('web-push');
const { db, getSetting, setSetting } = require('./db');
const { customerScope, customerSelfScope, currentPeriod } = require('./auth');
const { todayVN, nowVN, hourVN, addDays, fmtVND, renderTemplate, normKey } = require('./util');

function initVapid() {
  let pub = getSetting('vapid_public');
  let priv = getSetting('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    setSetting('vapid_public', pub);
    setSetting('vapid_private', priv);
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.invalid', pub, priv);
  return pub;
}

async function pushTo(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 12 * 3600, urgency: 'high' }
    );
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id);
    else console.warn('Gửi thông báo lỗi:', e.statusCode || e.message);
    return false;
  }
}

// ---------- Khách hàng
/**
 * Các khoản cước của 1 khách (theo phiên/thiết bị) ở kỳ hiện tại.
 * owner: chỉ lấy thuê bao thuộc CTV này (dùng cho lịch nhắc do CTV tự đặt).
 */
function customerBills(cust, period, { unpaidOnly = false, owner = null } = {}) {
  const sc = customerSelfScope(cust);
  const os = owner ? customerScope(owner) : { sql: '1=1', params: [] };
  return db
    .prepare(
      `SELECT c.* FROM customers c WHERE c.period_id = ? AND ${sc.sql} AND ${os.sql}
       ${unpaidOnly ? "AND c.trang_thai = 'chua_thu'" : ''} ORDER BY c.id`
    )
    .all(period.id, ...sc.params, ...os.params);
}

/** CTV phụ trách thuê bao (theo Mã CTV trong file). */
function ctvOfBill(bill) {
  if (!bill?.ma_nv_key) return null;
  const staff = db.prepare("SELECT * FROM users WHERE role='staff' AND active=1 AND staff_code <> ''").all();
  return staff.find((u) => normKey(u.staff_code) === bill.ma_nv_key) || null;
}

/**
 * Cài đặt thông báo áp dụng cho khách: lấy của CTV phụ trách, phần nào CTV chưa cài thì dùng cài đặt chung của admin.
 */
function notifySettingsFor(bill) {
  const ctv = ctvOfBill(bill);
  const own = ctv ? db.prepare('SELECT * FROM ctv_settings WHERE user_id = ?').get(ctv.id) : null;
  return {
    ctvId: ctv?.id || null,
    template: own?.customer_template || getSetting('customer_template'),
    supportUrl: own?.support_url || getSetting('support_url'),
    supportName: own?.support_name || getSetting('support_name') || 'nhóm hỗ trợ',
  };
}
function supportLine(st) {
  if (!st.supportUrl) return '';
  return String(getSetting('support_line') || '').replace(/\{nhom\}/g, st.supportName);
}

function customerMessage(bills, period, template) {
  if (!bills.length) return null;
  const first = bills[0];
  const merged = { ...first, so_tien: bills.reduce((s, b) => s + b.so_tien, 0) };
  const st = notifySettingsFor(first);
  const main = renderTemplate(template || st.template, merged, period.name);
  const line = supportLine(st);
  return {
    title: `Nhắc thanh toán cước ${period.name}`,
    body: line ? `${main}\n${line}` : main,
    url: '/app/',
    tag: 'nhac-cuoc-khach',
    support: st.supportUrl ? { url: st.supportUrl, name: st.supportName } : null,
  };
}

async function sendToCustomers({ template, onlyKey, ownerId } = {}) {
  const period = currentPeriod();
  if (!period) return { sent: 0, devices: 0, paidSkipped: 0 };
  const owner = ownerId ? db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId) : null;
  if (ownerId && !owner) return { sent: 0, devices: 0, paidSkipped: 0 };
  const subs = onlyKey
    ? db.prepare('SELECT * FROM push_subs WHERE cust_key = ?').all(onlyKey)
    : db.prepare('SELECT * FROM push_subs WHERE cust_key IS NOT NULL OR cust_phone IS NOT NULL').all();
  let sent = 0, paidSkipped = 0, devices = 0;
  for (const s of subs) {
    const cust = { custKey: s.cust_key || '', custHd: s.cust_hd || '', custPhone: s.cust_phone || '' };
    if (owner && !customerBills(cust, period, { owner }).length) continue; // thiết bị không thuộc khách của CTV này
    devices++;
    const bills = customerBills(cust, period, { unpaidOnly: true, owner });
    const msg = customerMessage(bills, period, template);
    if (!msg) {
      paidSkipped++;
      continue;
    }
    if (await pushTo(s, msg)) sent++;
  }
  return { sent, devices, paidSkipped };
}

// ---------- CTV
function ctvSummary(user, today = todayVN()) {
  const period = currentPeriod();
  if (!period) return null;
  const days = Math.max(0, parseInt(getSetting('remind_days_before'), 10) || 0);
  const sc = customerScope(user);
  const r = db
    .prepare(
      `SELECT
        SUM(CASE WHEN trang_thai='chua_thu' THEN 1 ELSE 0 END) chua_thu,
        SUM(CASE WHEN trang_thai='chua_thu' THEN so_tien ELSE 0 END) tien_chua_thu,
        SUM(CASE WHEN trang_thai='chua_thu' AND han_tt < ? THEN 1 ELSE 0 END) qua_han,
        SUM(CASE WHEN trang_thai='chua_thu' AND han_tt = ? THEN 1 ELSE 0 END) hom_nay,
        SUM(CASE WHEN trang_thai='chua_thu' AND han_tt > ? AND han_tt <= ? THEN 1 ELSE 0 END) sap_den,
        SUM(CASE WHEN ten_kh = '' OR sdt = '' THEN 1 ELSE 0 END) thieu_tt
       FROM customers c WHERE c.period_id = ? AND ${sc.sql}`
    )
    .get(today, today, today, addDays(today, days), period.id, ...sc.params);
  return { period: period.name, days, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v || 0])) };
}

function ctvMessage(s) {
  if (!s || !s.chua_thu) return null;
  const parts = [`Còn ${s.chua_thu} TB chưa thu (${fmtVND(s.tien_chua_thu)}đ)`];
  if (s.qua_han) parts.push(`${s.qua_han} quá hạn`);
  if (s.hom_nay) parts.push(`${s.hom_nay} đến hạn hôm nay`);
  if (s.sap_den) parts.push(`${s.sap_den} sắp đến hạn`);
  if (s.thieu_tt) parts.push(`${s.thieu_tt} TB cần bổ sung tên/SĐT`);
  return { title: `Thu cước ${s.period}`, body: parts.join(' • '), url: '/app/', tag: 'nhac-thu-cuoc-ctv' };
}

async function sendToCtv({ onlyUserId } = {}) {
  const users = onlyUserId
    ? db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').all(onlyUserId)
    : db.prepare("SELECT * FROM users WHERE active = 1 AND role = 'staff'").all();
  let sent = 0;
  for (const u of users) {
    const msg = ctvMessage(ctvSummary(u));
    if (!msg) continue;
    for (const s of db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(u.id)) if (await pushTo(s, msg)) sent++;
  }
  return { sent, users: users.length };
}

// ---------- Lịch gửi
async function runSchedule(sch) {
  const out = {};
  if (sch.owner_id) {
    // Lịch do CTV đặt → chỉ gửi khách của CTV đó
    out.khach = await sendToCustomers({ template: sch.message || undefined, ownerId: sch.owner_id });
  } else if (sch.target === 'khach' || sch.target === 'ca_hai') out.khach = await sendToCustomers({ template: sch.message || undefined });
  if (!sch.owner_id && (sch.target === 'ctv' || sch.target === 'ca_hai')) out.ctv = await sendToCtv();
  const parts = [];
  if (out.khach) parts.push(`Khách: gửi ${out.khach.sent}/${out.khach.devices} thiết bị (bỏ qua ${out.khach.paidSkipped} đã thanh toán)`);
  if (out.ctv) parts.push(`CTV: gửi ${out.ctv.sent} thông báo`);
  return parts.join(' · ');
}

function startScheduler({ autoSync }) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    const today = todayVN();
    const now = nowVN();
    try {
      if (getSetting('auto_sync') === '1' && getSetting('github_url') && getSetting('last_sync_date') !== today && hourVN() >= 6) {
        setSetting('last_sync_date', today);
        await autoSync();
      }
    } catch (e) {
      console.warn('Tự đồng bộ GitHub lỗi:', e.message);
    }
    try {
      const due = db.prepare("SELECT * FROM schedules WHERE status = 'cho' AND send_at <= ? ORDER BY send_at").all(now);
      for (const sch of due) {
        // Quá giờ hơn 6 tiếng (máy chủ tắt lúc đó) → không gửi muộn vào ban đêm
        const lateMin = (Date.parse(now.replace(' ', 'T') + ':00Z') - Date.parse(sch.send_at.replace(' ', 'T') + ':00Z')) / 60e3;
        if (lateMin > 360) {
          db.prepare("UPDATE schedules SET status='loi', sent_at=?, result=? WHERE id=?").run(now, 'Bỏ qua: máy chủ không chạy vào giờ hẹn', sch.id);
          continue;
        }
        db.prepare("UPDATE schedules SET status='da_gui', sent_at=? WHERE id=?").run(now, sch.id);
        const result = await runSchedule(sch);
        db.prepare('UPDATE schedules SET result=? WHERE id=?').run(result, sch.id);
        console.log(`[${now}] Lịch #${sch.id}: ${result}`);
      }
    } catch (e) {
      console.warn('Chạy lịch gửi lỗi:', e.message);
    }
    try {
      const at = parseInt(getSetting('remind_hour'), 10);
      if (getSetting('ctv_daily') === '1' && hourVN() >= (isNaN(at) ? 8 : at) && getSetting('last_notify_date') !== today) {
        setSetting('last_notify_date', today);
        const r = await sendToCtv();
        console.log(`[${now}] Tóm tắt CTV: gửi ${r.sent} thông báo.`);
      }
    } catch (e) {
      console.warn('Nhắc CTV lỗi:', e.message);
    }
    busy = false;
  };
  setInterval(tick, 30_000).unref();
  setTimeout(tick, 3_000).unref();
}

module.exports = {
  initVapid, pushTo, customerBills, customerMessage, notifySettingsFor, supportLine, sendToCustomers, ctvSummary, ctvMessage, sendToCtv, runSchedule, startScheduler,
};
