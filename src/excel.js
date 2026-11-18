// Đọc file Excel đầu kỳ thu cước và nhập vào CSDL.
const ExcelJS = require('exceljs');
const { db, tx } = require('./db');
const { normKey, todayVN } = require('./util');

// Các tên cột được chấp nhận (đã chuẩn hoá: bỏ dấu, chữ thường, bỏ khoảng trắng).
const COLUMN_ALIASES = {
  ma_kh: ['sotb', 'sothuebao', 'thuebao', 'makh', 'makhachhang', 'mathuebao', 'matb', 'account', 'idkh', 'makhthanhtoan', 'matt', 'ma'],
  ma_hd: ['mahopdong', 'mahd', 'sohopdong', 'sohd', 'hopdong'],
  ten_kh: ['tenkh', 'tenkhachhang', 'khachhang', 'hoten', 'hovaten', 'tenthuebao', 'tenchuthuebao', 'ten'],
  sdt: ['sodtlienhe', 'sdtlienhe', 'sdt', 'sodienthoai', 'dienthoai', 'sodt', 'didong', 'dienthoailienhe', 'sodienthoailienhe', 'phone', 'mobile'],
  dia_chi: ['diachi', 'diachilapdat', 'diachithanhtoan', 'diachikh', 'address'],
  dia_ban: ['tendiaban', 'diaban', 'khuvuc', 'tuyenthu', 'tuyen', 'phuongxa', 'xaphuong', 'phuong', 'xa', 'area', 'quanhuyen'],
  ma_nv: ['mactv', 'ctv', 'macongtacvien', 'manv', 'manhanvien', 'nhanvien', 'nvthu', 'nhanvienthu', 'nhanvienthucuoc', 'nguoithu', 'tennv', 'tennhanvien', 'nvql', 'nhanvienquanly', 'nhanvienphutrach'],
  dich_vu: ['loaithuebao', 'dichvu', 'tendichvu', 'loaidichvu', 'goicuoc', 'tengoicuoc', 'goi', 'service'],
  so_tien: ['sotien', 'sotienphaithu', 'phaithu', 'cuocphaithu', 'tongtien', 'tongcuoc', 'tongphaithu', 'cuoc', 'tien', 'amount', 'thanhtien', 'notruoc'],
  han_tt: ['hanthanhtoan', 'hantt', 'handong', 'hannop', 'hanthu', 'ngaydenhan', 'ngayhethan', 'hanchot', 'duedate', 'han'],
  trang_thai: ['trangthai', 'tinhtrang', 'tinhtrangthu', 'trangthaithanhtoan', 'tinhtrangthanhtoan', 'status'],
  // Số tiền còn nợ: = 0 → đã thanh toán hết
  con_no: ['conno', 'nocon', 'noconlai', 'sotienconno', 'conphaithu', 'conlai', 'sodu', 'nocuoc', 'tienno'],
  // Số tiền đã nộp: ≥ Tổng cước → đã thanh toán hết
  da_nop: ['danop', 'sotiendanop', 'dathu', 'sotiendathu', 'dathanhtoan', 'sotiendathanhtoan', 'datra', 'sotiendatra', 'thucthu'],
  ghi_chu: ['ghichu', 'note', 'notes'],
};

function mapHeader(raw) {
  const k = normKey(raw);
  if (!k) return null;
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) if (aliases.includes(k)) return field;
  // so khớp gần đúng cho tên cột dài, vd "Số tiền phải thu kỳ 11"
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES))
    if (aliases.some((a) => a.length >= 5 && k.startsWith(a))) return field;
  return null;
}

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    // Ô công thức: chỉ lấy kết quả đã lưu. Công thức trỏ sang file khác mà không có kết quả → coi như trống.
    if ('formula' in v || 'sharedFormula' in v || 'result' in v) return v.result === undefined ? '' : cellValue(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return cellValue(v.text);
    if ('error' in v) return '';
    return String(v);
  }
  return v;
}

// Chỉ nhận ngày có thật (loại 31/02, 30/13…)
function validYMD(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
}
function toYMD(v) {
  return validYMD(toYMDRaw(v));
}
function toYMDRaw(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

function toMoney(v) {
  if (typeof v === 'number') return Math.round(v);
  const digits = String(v ?? '').replace(/[^\d-]/g, '');
  return digits ? parseInt(digits, 10) || 0 : 0;
}

function toStatus(v) {
  const k = normKey(v);
  if (!k) return 'chua_thu';
  if (['x', '1', 'co', 'ok', 'paid', 'dathu', 'dathanhtoan', 'datt', 'roi', 'hoanthanh'].includes(k)) return 'da_thu';
  if (k.startsWith('dathu') || k.startsWith('dathanhtoan')) return 'da_thu';
  return 'chua_thu';
}

function cleanPhone(v) {
  let s = String(v ?? '').replace(/[^\d+]/g, '');
  if (/^\+?84\d{9,10}$/.test(s)) s = '0' + s.replace(/^\+?84/, '');
  if (/^\d{9}$/.test(s)) s = '0' + s; // Excel hay làm mất số 0 đầu
  if (s.replace(/\D/g, '').length < 8) return ''; // "0", ô lỗi...
  return s;
}

// Số TB: thuê bao di động dạng số bị Excel mất số 0 đầu → thêm lại. Tài khoản (vd q055_gftth_x) giữ nguyên.
function cleanSubscriber(v) {
  const s = String(v ?? '').trim();
  if (/^\d{9}$/.test(s)) return '0' + s;
  if (/^84\d{9}$/.test(s)) return '0' + s.slice(2);
  return s;
}
const isMobile = (s) => /^0[35789]\d{8}$/.test(s);
const blank0 = (v) => {
  const s = String(v ?? '').trim();
  return s === '0' || s === '#N/A' ? '' : s;
};

/** Đọc toàn bộ workbook → danh sách dòng khách hàng đã chuẩn hoá. */
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new Error('Không đọc được file. Hãy dùng file Excel dạng .xlsx (Excel 2007 trở lên).');
  }
  const rows = [];
  const sheets = [];
  wb.eachSheet((ws) => {
    // Tìm dòng tiêu đề trong 15 dòng đầu: dòng có nhiều cột nhận diện được nhất.
    let best = { row: 0, map: {}, score: 0 };
    for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
      const map = {};
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => {
        const f = mapHeader(cellValue(cell.value));
        if (f && !Object.values(map).includes(f)) map[col] = f;
      });
      const fields = Object.values(map);
      const score = fields.length + (fields.includes('ten_kh') || fields.includes('ma_kh') ? 2 : 0);
      if (score > best.score) best = { row: r, map, score };
    }
    const fields = Object.values(best.map);
    if (best.score < 4 || !(fields.includes('ten_kh') || fields.includes('ma_kh'))) {
      sheets.push({ name: ws.name, skipped: true, reason: 'Không tìm thấy dòng tiêu đề (cần ít nhất cột Tên KH hoặc Mã KH)' });
      return;
    }
    let count = 0;
    for (let r = best.row + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rec = {};
      for (const [col, field] of Object.entries(best.map)) rec[field] = cellValue(row.getCell(Number(col)).value);
      const ma = cleanSubscriber(rec.ma_kh);
      const ten = blank0(rec.ten_kh);
      if (!ma && !ten) continue;
      if (!ma && /^(tongcong|tong|cong)$/.test(normKey(ten).replace(/\d+/g, ''))) continue; // bỏ dòng "Tổng cộng" (không có Số TB)
      let sdt = cleanPhone(rec.sdt);
      if (!sdt && isMobile(ma)) sdt = ma; // thuê bao di động: Số TB chính là số liên hệ
      rows.push({
        ma_kh: ma,
        ma_hd: blank0(rec.ma_hd),
        ten_kh: ten,
        sdt,
        dia_chi: String(rec.dia_chi ?? '').trim(),
        dia_ban: String(rec.dia_ban ?? '').trim() || (fields.includes('dia_ban') ? '' : ws.name.trim()),
        ma_nv: String(rec.ma_nv ?? '').trim(),
        dich_vu: String(rec.dich_vu ?? '').trim(),
        so_tien: toMoney(rec.so_tien),
        han_tt: toYMD(rec.han_tt),
        trang_thai: paidFromFile(rec, fields),
        ghi_chu: String(rec.ghi_chu ?? '').trim(),
      });
      count++;
    }
    sheets.push({ name: ws.name, headerRow: best.row, columns: fields, rows: count });
  });
  return { rows, sheets };
}

/**
 * Trạng thái thanh toán đọc từ file:
 *  - cột Trạng thái ghi "Đã thanh toán" / "Đã thu" / "x"…
 *  - cột Còn nợ = 0
 *  - cột Đã nộp ≥ Tổng cước
 */
function paidFromFile(rec, fields) {
  if (toStatus(rec.trang_thai) === 'da_thu') return 'da_thu';
  const tien = toMoney(rec.so_tien);
  if (fields.includes('con_no') && String(rec.con_no ?? '').trim() !== '' && toMoney(rec.con_no) <= 0 && tien > 0) return 'da_thu';
  if (fields.includes('da_nop') && tien > 0 && toMoney(rec.da_nop) >= tien) return 'da_thu';
  return 'chua_thu';
}

// Khoá ghép dòng giữa các lần đồng bộ: ưu tiên Mã hợp đồng, rồi Số TB.
function rowKey(r) {
  if (r.ma_hd) return 'hd:' + normKey(r.ma_hd);
  if (r.ma_kh) return 'tb:' + normKey(r.ma_kh);
  return 'ten:' + normKey(r.ten_kh + '|' + r.sdt + '|' + r.dich_vu);
}

/**
 * Nhập dữ liệu.
 * mode = 'new'    → tạo kỳ cước mới và đặt làm kỳ hiện tại.
 * mode = 'update' → cập nhật vào kỳ hiện tại (giữ trạng thái "đã thu" CTV đã đánh dấu).
 * createAccounts  → tự tạo tài khoản đăng nhập cho Mã CTV chưa có tài khoản.
 * markMissingPaid → (chỉ khi cập nhật) thuê bao không còn trong file nợ mới → tự đánh dấu đã thanh toán.
 *
 * Tự cập nhật "đã thu" khi đồng bộ lại (paid_source = 'file'):
 *  - file ghi đã thanh toán (cột Trạng thái / Còn nợ = 0 / Đã nộp đủ);
 *  - Tổng cước trước > 0 mà file mới = 0 (đã trả hết) – giữ số tiền cũ để thống kê "đã thu" đúng.
 */
function importRows({ rows, sheets }, { mode = 'new', periodName, defaultDue, source, createAccounts = false, markMissingPaid = false, hashPassword, randomPassword }) {
  if (!rows.length) throw new Error('File không có dòng khách hàng nào đọc được.');
  return tx(() => {
    let period;
    if (mode === 'update') {
      period = db.prepare('SELECT * FROM periods WHERE is_current = 1 ORDER BY id DESC LIMIT 1').get();
      if (!period) mode = 'new';
    }
    if (mode === 'new') {
      const name = periodName || `Tháng ${todayVN().slice(5, 7)}/${todayVN().slice(0, 4)}`;
      db.prepare('UPDATE periods SET is_current = 0').run();
      const r = db
        .prepare('INSERT INTO periods(name, source, default_due, is_current) VALUES(?,?,?,1)')
        .run(name, source || '', defaultDue || null);
      period = db.prepare('SELECT * FROM periods WHERE id = ?').get(r.lastInsertRowid);
    } else {
      if (defaultDue) {
        db.prepare('UPDATE customers SET han_tt = ? WHERE period_id = ? AND (han_tt IS NULL OR han_tt = ?)').run(
          defaultDue, period.id, period.default_due || ''
        );
        period.default_due = defaultDue;
      }
      db.prepare('UPDATE periods SET default_due = ?, source = ? WHERE id = ?').run(period.default_due, source || period.source, period.id);
    }

    const due = period.default_due;
    const existing = new Map();
    if (mode === 'update') {
      for (const c of db.prepare('SELECT * FROM customers WHERE period_id = ?').all(period.id)) existing.set(rowKey(c), c);
    }
    const overrides = new Map(db.prepare('SELECT * FROM customer_overrides').all().map((o) => [o.ma_kh_key, o]));

    const ins = db.prepare(`INSERT INTO customers
      (period_id, ma_kh, ma_kh_key, ma_hd, ten_kh, sdt, dia_chi, dia_ban, dia_ban_key, ma_nv, ma_nv_key, dich_vu, so_tien, han_tt, trang_thai, ngay_thu, ghi_chu, paid_source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const upd = db.prepare(`UPDATE customers SET ma_kh=?, ma_kh_key=?, ma_hd=?, ten_kh=?, sdt=?, dia_chi=?, dia_ban=?, dia_ban_key=?, ma_nv=?, ma_nv_key=?,
      dich_vu=?, so_tien=?, han_tt=?, trang_thai=?, ngay_thu=?, ghi_chu=?, paid_source=?, updated_at=datetime('now') WHERE id=?`);

    let inserted = 0, updated = 0, noDue = 0, fromOverride = 0, missingName = 0, missingPhone = 0, autoPaid = 0, autoPaidMissing = 0;
    const seen = new Set();
    for (const r of rows) {
      const tbKey = normKey(r.ma_kh);
      // Bổ sung tên/SĐT CTV đã nhập tay ở các lần trước (file có giá trị thì ưu tiên file)
      const ov = tbKey && overrides.get(tbKey);
      if (ov) {
        if (!r.ten_kh && ov.ten_kh) { r.ten_kh = ov.ten_kh; fromOverride++; }
        if (!r.sdt && ov.sdt) r.sdt = ov.sdt;
      }
      if (!r.ten_kh) missingName++;
      if (!r.sdt) missingPhone++;
      const han = r.han_tt || due || null;
      if (!han) noDue++;
      const key = rowKey(r);
      const old = existing.get(key);
      if (old && !seen.has(key)) {
        seen.add(key);
        // Đã trả hết theo file mới: file ghi đã thanh toán, hoặc cước trước > 0 mà nay = 0
        const zeroNow = old.so_tien > 0 && r.so_tien <= 0;
        const paidByFile = old.trang_thai !== 'da_thu' && (r.trang_thai === 'da_thu' || zeroNow);
        if (paidByFile) autoPaid++;
        const status = old.trang_thai === 'da_thu' || paidByFile ? 'da_thu' : 'chua_thu';
        const ngayThu = status === 'da_thu' ? old.ngay_thu || todayVN() : null;
        const soTien = zeroNow ? old.so_tien : r.so_tien; // giữ số tiền cũ để "đã thu" thống kê đúng
        upd.run(r.ma_kh, tbKey, r.ma_hd, r.ten_kh || old.ten_kh, r.sdt || old.sdt, r.dia_chi, r.dia_ban, normKey(r.dia_ban),
          r.ma_nv, normKey(r.ma_nv), r.dich_vu, soTien, han, status, ngayThu, r.ghi_chu || old.ghi_chu,
          paidByFile ? 'file' : old.paid_source || '', old.id);
        updated++;
      } else {
        ins.run(period.id, r.ma_kh, tbKey, r.ma_hd, r.ten_kh, r.sdt, r.dia_chi, r.dia_ban, normKey(r.dia_ban), r.ma_nv,
          normKey(r.ma_nv), r.dich_vu, r.so_tien, han, r.trang_thai, r.trang_thai === 'da_thu' ? todayVN() : null, r.ghi_chu,
          r.trang_thai === 'da_thu' ? 'file' : '');
        inserted++;
      }
    }

    // Thuê bao không còn trong file nợ mới → coi như đã thanh toán (chỉ khi admin bật)
    const missing = mode === 'update' ? [...existing.entries()].filter(([k, c]) => !seen.has(k) && c.trang_thai === 'chua_thu') : [];
    let missingSkipped = '';
    if (markMissingPaid && missing.length) {
      // An toàn: file mới quá ít dòng (vd chỉ 1 địa bàn) → không tự đánh dấu, tránh đánh dấu nhầm hàng loạt
      if (rows.length < existing.size * 0.3) {
        missingSkipped = `File mới chỉ có ${rows.length}/${existing.size} thuê bao – có thể là file một phần, nên KHÔNG tự đánh dấu ${missing.length} thuê bao vắng mặt là đã thanh toán.`;
      } else {
        const mark = db.prepare(
          "UPDATE customers SET trang_thai='da_thu', ngay_thu=?, paid_source='file', updated_at=datetime('now') WHERE id=? AND trang_thai='chua_thu'"
        );
        for (const [, c] of missing) autoPaidMissing += mark.run(todayVN(), c.id).changes;
      }
    }

    // Tự tạo tài khoản cho Mã CTV mới (tên đăng nhập = Mã CTV)
    const newAccounts = [];
    if (createAccounts) {
      const codes = new Map();
      for (const r of rows) if (r.ma_nv) codes.set(normKey(r.ma_nv), r.ma_nv);
      const have = new Set(
        db.prepare('SELECT staff_code, username FROM users').all().flatMap((u) => [normKey(u.staff_code), normKey(u.username)])
      );
      const add = db.prepare("INSERT INTO users(username, password_hash, full_name, role, staff_code) VALUES(?,?,?,'staff',?)");
      for (const [k, code] of codes) {
        if (have.has(k)) continue;
        if (!/^[A-Za-z0-9._-]{3,40}$/.test(code)) continue;
        const pw = randomPassword();
        add.run(code, hashPassword(pw), code, code);
        newAccounts.push({ username: code, password: pw });
      }
    }

    const warnings = [];
    if (noDue) warnings.push(`${noDue} thuê bao chưa có hạn thanh toán. Hãy nhập "Hạn thanh toán của kỳ" để app nhắc đúng.`);
    if (missingName) warnings.push(`${missingName} thuê bao chưa có tên – CTV có thể nhập bổ sung trên app.`);
    if (missingPhone) warnings.push(`${missingPhone} thuê bao chưa có SĐT liên hệ – CTV có thể nhập bổ sung trên app. (Nếu cột SĐT trong file là công thức VLOOKUP sang file khác, hãy Copy → Paste Values trước khi đưa lên GitHub.)`);
    if (missingSkipped) warnings.push(missingSkipped);
    if (mode === 'update' && missing.length && !markMissingPaid)
      warnings.push(`${missing.length} thuê bao chưa thu không còn trong file mới – nếu file mới là danh sách CÒN NỢ, hãy bật "Tự đánh dấu đã thanh toán cho thuê bao không còn trong file" rồi đồng bộ lại.`);
    return {
      autoPaid,
      autoPaidMissing,
      period: { id: period.id, name: period.name, default_due: period.default_due },
      mode,
      sheets,
      total: rows.length,
      totalMoney: rows.reduce((s, r) => s + r.so_tien, 0),
      inserted,
      updated,
      fromOverride,
      notInFile: mode === 'update' ? existing.size - seen.size : 0,
      newAccounts,
      warnings,
    };
  });
}

/** Phân tích độ phủ: thuê bao của kỳ chưa có CTV (tài khoản đang hoạt động) phụ trách. */
function coverage(periodId) {
  const staff = db.prepare("SELECT * FROM users WHERE role = 'staff' AND active = 1").all();
  const nvKeys = new Set();
  const areaKeys = new Set();
  for (const u of staff) {
    if (u.staff_code) nvKeys.add(normKey(u.staff_code));
    for (const a of String(u.areas).split(/[,;\n]/)) if (a.trim()) areaKeys.add(normKey(a));
  }
  const groups = db
    .prepare(
      `SELECT ma_nv, ma_nv_key, dia_ban, dia_ban_key, COUNT(*) n, SUM(so_tien) tien
       FROM customers WHERE period_id = ? GROUP BY ma_nv_key, dia_ban_key`
    )
    .all(periodId);
  const orphan = groups.filter((g) => !nvKeys.has(g.ma_nv_key) && !areaKeys.has(g.dia_ban_key));
  return {
    orphanCustomers: orphan.reduce((s, g) => s + g.n, 0),
    orphanGroups: orphan.map((g) => ({ ma_nv: g.ma_nv, dia_ban: g.dia_ban, n: g.n, tien: g.tien })),
  };
}

/** File Excel mẫu – cùng cấu trúc với file cước đầu kỳ. */
async function sampleWorkbook() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet0');
  ws.columns = [
    { header: 'Tên KH', key: 'ten', width: 26 },
    { header: 'Số TB', key: 'tb', width: 22 },
    { header: 'Loại thuê bao', key: 'loai', width: 14 },
    { header: 'Số ĐT liên hệ', key: 'sdt', width: 14 },
    { header: 'Tổng cước', key: 'tien', width: 12, style: { numFmt: '#,##0' } },
    { header: 'Mã CTV', key: 'ctv', width: 20 },
    { header: 'Tên địa bàn', key: 'db', width: 34 },
    { header: 'Mã hợp đồng', key: 'hd', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  [
    ['Nguyễn Văn A', '0912345678', 'POBAS', '0912345678', 51916, 'CTV01_DEMO', 'Thôn 1 Xã Mẫu', '600000001'],
    ['', 'demo_gftth_userb', 'NET1', '', 180000, 'CTV01_DEMO', 'Thôn 1 Xã Mẫu', '600000002'],
    ['Trần Thị C', 'demo_gftth_userc', 'SUPERNET1', '0987654321', 225000, 'CTV02_DEMO', 'Thôn 2 Xã Mẫu', '600000003'],
  ].forEach((r) => ws.addRow(r));
  const hd = wb.addWorksheet('HuongDan');
  hd.getColumn(1).width = 110;
  [
    'HƯỚNG DẪN FILE CƯỚC ĐẦU KỲ',
    '',
    '• Cột bắt buộc: Số TB, Tổng cước, Mã CTV. Nên có: Tên KH, Số ĐT liên hệ, Tên địa bàn, Mã hợp đồng.',
    '• Mã CTV là tên đăng nhập của CTV – CTV chỉ thấy thuê bao có đúng Mã CTV của mình.',
    '• Khách hàng đăng nhập app bằng Số TB + Mã hợp đồng (hoặc Số ĐT liên hệ).',
    '• Cột Số ĐT liên hệ nếu là công thức (VLOOKUP) phải Copy → Paste Values trước khi đưa lên GitHub.',
    '• Tên KH = 0 hoặc trống, SĐT trống: CTV nhập bổ sung trên app, hệ thống nhớ cho các kỳ sau.',
    '• Các cột khác (Loại thuê bao, Ngày đấu nối, Hình thức quản lý, Mã địa bàn...) có thể giữ nguyên.',
  ].forEach((t, i) => {
    hd.getCell(i + 1, 1).value = t;
    if (i === 0) hd.getCell(1, 1).font = { bold: true, size: 14 };
  });
  return wb.xlsx.writeBuffer();
}

module.exports = { parseWorkbook, importRows, coverage, sampleWorkbook, toYMD, toMoney, cleanPhone, cleanSubscriber, mapHeader };
