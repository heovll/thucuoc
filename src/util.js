// Hàm tiện ích dùng chung.

// Chuẩn hoá chuỗi để so khớp: bỏ dấu tiếng Việt, chữ thường, bỏ ký tự không phải chữ/số.
function normKey(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Ngày hôm nay theo giờ Việt Nam, dạng YYYY-MM-DD.
function todayVN(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
function hourVN(d = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hour12: false }).format(d)
  ) % 24;
}
// 'YYYY-MM-DD HH:MM' giờ Việt Nam
function nowVN(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`;
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function fmtVND(n) {
  return Number(n || 0).toLocaleString('vi-VN');
}
function fmtDateVN(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}
function splitAreas(s) {
  return String(s ?? '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Gộp chữ bị lặp do mẫu tin và giá trị biến trùng nhau, vd:
 *  "tháng {ky}" với kỳ "Tháng 10/2026"      → "tháng Tháng 10/2026" → "tháng 10/2026"
 *  "trước ngày {han}" với mẫu cũ thêm sẵn chữ → "trước ngày trước ngày 15/11" → "trước ngày 15/11"
 */
function dedupeWords(s) {
  return String(s)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(trước ngày|truoc ngay|tháng|thang|kỳ|ky|ngày|ngay)\s+\1(?=[\s\d])/giu, '$1')
    .replace(/\s+([.,!?])/g, '$1');
}

// Điền mẫu tin nhắn: {ten} {sotb} {sdt} {sotien} {diaban} {ky} {han} {mactv} {link}
// {han} chỉ là ngày (vd 15/11/2026) – mẫu tự viết "trước ngày {han}".
function renderTemplate(tpl, c, periodName) {
  const vars = {
    ten: c.ten_kh || 'Quý khách',
    sotb: c.ma_kh || '',
    sdt: c.sdt || '—',
    sotien: fmtVND(c.so_tien),
    diaban: c.dia_ban || '—',
    ky: periodName || '',
    han: c.han_tt ? fmtDateVN(c.han_tt) : '',
    mactv: c.ma_nv || '',
    link: c.link || '',
  };
  let out = String(tpl || '');
  // mẫu kiểu cũ "đúng hạn{han}" (dính liền) → "đúng hạn trước ngày 15/11/2026"
  out = out.replace(/hạn\{han\}/g, c.han_tt ? 'hạn trước ngày {han}' : 'hạn');
  out = out.replace(/han\{han\}/g, c.han_tt ? 'han truoc ngay {han}' : 'han');
  out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return dedupeWords(out);
}

module.exports = { normKey, todayVN, nowVN, hourVN, addDays, fmtVND, fmtDateVN, splitAreas, renderTemplate, dedupeWords };
