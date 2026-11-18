// Trang quản trị – JavaScript thuần, không cần build.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => Number(n || 0).toLocaleString('vi-VN');
  const dmy = (ymd) => (ymd ? ymd.slice(0, 10).split('-').reverse().join('/') : '');
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const utcToVN = (s) => {
    if (!s) return '';
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
  };
  const TOKEN_KEY = 'tc_admin_token';
  const store = {
    get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set: (v) => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} },
  };
  let me = null;

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const t = store.get();
    if (t) headers.Authorization = 'Bearer ' + t;
    let body = opts.body;
    if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(path, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
    if (res.status === 401 && !path.endsWith('/login')) {
      store.set(null);
      showLogin();
      throw new Error('Phiên đăng nhập đã hết hạn.');
    }
    if (opts.raw) {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Lỗi tải file');
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
    return data;
  }
  async function download(path, filename) {
    try {
      const res = await api(path, { raw: true });
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message); }
  }
  function toast(msg, ms = 3200) {
    const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
    document.body.append(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------------------------------------------------------- Hộp thoại
  const dlg = $('#dlg');
  function openDialog(html, onSubmit) {
    const form = $('#dlgForm');
    form.innerHTML = html;
    dlg.showModal();
    const first = form.querySelector('input,select,textarea');
    if (first) first.focus();
    form.onsubmit = async (e) => {
      const submitter = e.submitter;
      if (!submitter || submitter.value !== 'ok') return; // nút Huỷ
      e.preventDefault();
      const err = form.querySelector('.dlg-err');
      try {
        submitter.disabled = true;
        await onSubmit(Object.fromEntries(new FormData(form)), form);
        dlg.close();
      } catch (ex) {
        if (err) { err.textContent = ex.message; err.classList.remove('hidden'); } else toast(ex.message);
      } finally { submitter.disabled = false; }
    };
  }
  const dlgButtons = (okText = 'Lưu') =>
    `<div class="alert error dlg-err hidden"></div><div class="dlg-actions"><button value="cancel" formnovalidate>Huỷ</button><button value="ok" class="btn-primary">${okText}</button></div>`;
  function showSecret(title, rows) {
    openDialog(
      `<h2>${esc(title)}</h2><p class="muted small">Ghi lại hoặc gửi cho CTV ngay – mật khẩu chỉ hiện một lần.</p>
       <div class="table-wrap"><table><thead><tr><th>Mã CTV (tên đăng nhập)</th><th>Mật khẩu</th></tr></thead><tbody>
       ${rows.map((r) => `<tr><td>${esc(r.username)}</td><td><code>${esc(r.password)}</code></td></tr>`).join('')}</tbody></table></div>
       <div class="dlg-actions"><button type="button" id="copySecrets">Sao chép</button><button value="cancel" class="btn-primary">Đã ghi lại</button></div>`,
      async () => {}
    );
    $('#copySecrets').onclick = () => {
      navigator.clipboard?.writeText(rows.map((r) => `${r.username}\t${r.password}`).join('\n')).then(() => toast('Đã sao chép'));
    };
  }

  // ---------------------------------------------------------- Đăng nhập
  function showLogin() {
    $('#shell').classList.add('hidden');
    $('#login').classList.remove('hidden');
  }
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const err = $('#loginErr');
    err.classList.add('hidden');
    try {
      const r = await api('/api/login', { body: { username: f.get('username'), password: f.get('password'), client: 'admin' } });
      store.set(r.token);
      start();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  };
  $('#logout').onclick = async () => {
    await api('/api/logout', { body: {} }).catch(() => {});
    store.set(null);
    showLogin();
  };

  async function start() {
    if (!store.get()) return showLogin();
    try {
      const r = await api('/api/me');
      if (r.kind !== 'user' || r.user.role !== 'admin') throw new Error();
      me = r.user;
    } catch {
      store.set(null);
      return showLogin();
    }
    $('#login').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    $('#meName').textContent = `Đăng nhập: ${me.username}`;
    route();
  }

  // ---------------------------------------------------------- Điều hướng
  const views = {};
  const main = $('#main');
  async function refreshRegBadge() {
    try {
      const r = await api('/api/admin/registrations?status=cho');
      const b = $('#regBadge');
      b.textContent = r.pending;
      b.classList.toggle('hidden', !r.pending);
      return r.pending;
    } catch { return 0; }
  }
  // Trang có số liệu thu cước tự làm mới mỗi 30 giây (CTV bấm "Đã thu" / tự đồng bộ file → tiến độ tăng ngay)
  const AUTO_REFRESH = new Set(['tong-quan', 'ky-cuoc']);
  let refreshTimer = null;
  function stampRefresh() {
    const h = main.querySelector('.page-head');
    if (!h) return;
    let s = main.querySelector('#refreshStamp');
    if (!s) {
      s = Object.assign(document.createElement('div'), { id: 'refreshStamp', className: 'small muted' });
      s.style.cssText = 'margin:-8px 0 12px';
      h.after(s);
    }
    s.textContent = `🔄 Tự cập nhật mỗi 30 giây · lần cuối ${new Date().toLocaleTimeString('vi-VN', { hour12: false })}`;
  }
  function route() {
    refreshRegBadge();
    clearInterval(refreshTimer);
    const v = (location.hash || '#tong-quan').slice(1);
    const view = views[v] || views['tong-quan'];
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
    main.innerHTML = '<p class="muted">Đang tải…</p>';
    view().then(() => AUTO_REFRESH.has(v) && stampRefresh()).catch((e) => {
      main.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    });
    if (AUTO_REFRESH.has(v)) {
      refreshTimer = setInterval(() => {
        // không làm mới khi đang mở hộp thoại, tab ẩn, hoặc đã chuyển trang
        if (dlg.open || document.visibilityState !== 'visible' || (location.hash || '#tong-quan').slice(1) !== v) return;
        const y = window.scrollY;
        view().then(() => { stampRefresh(); window.scrollTo(0, y); refreshRegBadge(); }).catch(() => {});
      }, 30_000);
    }
  }
  window.addEventListener('hashchange', () => me && route());

  // ---------------------------------------------------------- Tổng quan
  views['tong-quan'] = async () => {
    const d = await api('/api/admin/dashboard');
    const regAlert = (d.pendingRegs ? `<div class="alert warn">Có <b>${d.pendingRegs}</b> CTV đăng ký đang chờ duyệt. <a href="#duyet">Duyệt ngay</a></div>` : '') +
      (d.supportSet ? '' : '<div class="alert warn">Chưa có <b>link nhóm Tammi</b> – khách không thấy nút “Vào nhóm”. <a href="#lich-thong-bao">Thêm link nhóm</a></div>');
    if (!d.period) {
      main.innerHTML = `<div class="page-head"><h1>Tổng quan</h1></div>${regAlert}
        <div class="card"><h2>Chưa có dữ liệu cước</h2><p>Bắt đầu bằng cách nhập file cước đầu kỳ từ GitHub hoặc tải file lên.</p>
        <a class="btn btn-primary" href="#nhap-du-lieu">Nhập dữ liệu</a></div>`;
      return;
    }
    const t = d.total;
    const ns = d.nextSchedule;
    main.innerHTML = `
      <div class="page-head"><div><h1>Tổng quan · ${esc(d.period.name)}</h1>
        <div class="muted small">Hạn thanh toán: <b>${d.period.default_due ? dmy(d.period.default_due) : 'chưa đặt'}</b>
        · <a href="#" id="editPeriod">Sửa kỳ / hạn</a></div></div>
        <button id="exportBtn">Xuất Excel kết quả thu</button></div>
      ${regAlert}
      ${!d.period.default_due ? `<div class="alert warn">Kỳ này chưa có hạn thanh toán. Hãy <a href="#" id="editPeriod2">đặt hạn</a> để app hiển thị và nhắc đúng hạn.</div>` : ''}
      ${d.coverage.orphanCustomers ? `<div class="alert warn">${money(d.coverage.orphanCustomers)} thuê bao chưa có tài khoản CTV phụ trách: ${d.coverage.orphanGroups.slice(0, 6).map((g) => esc(g.ma_nv || '(trống)')).join(', ')}… <a href="#ctv">Tạo tài khoản</a></div>` : ''}
      <div class="kpis">
        <div class="card kpi"><div class="label">Thuê bao</div><div class="value num">${money(t.n)}</div><div class="sub">${d.byStaff.length} CTV · ${d.byArea.length} địa bàn</div></div>
        <div class="card kpi"><div class="label">Tổng cước</div><div class="value num">${money(t.tien)}đ</div></div>
        <div class="card kpi ok"><div class="label">Đã thu</div><div class="value num">${pct(t.tien_thu, t.tien)}%</div><div class="sub">${money(t.n_thu)} TB · ${money(t.tien_thu)}đ</div></div>
        <div class="card kpi warn"><div class="label">Chưa thu</div><div class="value num">${money(t.n - t.n_thu)}</div><div class="sub">${money(t.tien - t.tien_thu)}đ</div></div>
        <div class="card kpi danger"><div class="label">Quá hạn</div><div class="value num">${money(t.qua_han)}</div><div class="sub">chưa thu, đã quá hạn</div></div>
        <div class="card kpi"><div class="label">Thiếu tên / SĐT</div><div class="value num">${money(t.thieu_ten)} / ${money(t.thieu_sdt)}</div><div class="sub">CTV bổ sung trên app</div></div>
        <div class="card kpi"><div class="label">Khách đã cài app</div><div class="value num">${money(d.devices.khach)}</div><div class="sub">bật thông báo · CTV: ${d.devices.ctv}</div></div>
        <div class="card kpi"><div class="label">Lịch nhắc kế tiếp</div><div class="value" style="font-size:1.05rem">${ns ? esc(ns.send_at.slice(11) + ' ' + dmy(ns.send_at.slice(0, 10))) : '—'}</div><div class="sub">${ns ? '' : '<a href="#lich-thong-bao">Đặt lịch</a>'}</div></div>
      </div>
      <div class="stack">
        <div><h2>Theo CTV</h2><div class="table-wrap"><table><thead><tr>
          <th>Mã CTV</th><th class="r">Thuê bao</th><th class="r">Tổng cước</th><th class="r">Đã thu</th><th>Tiến độ</th><th class="r">Quá hạn</th><th class="r">Thiếu tên/SĐT</th><th>Đăng nhập gần nhất</th><th class="r">Thiết bị</th>
        </tr></thead><tbody>
        ${d.byStaff.map((s) => `<tr>
          <td><a href="#thue-bao" data-nv="${esc(s.staff_code)}">${esc(s.staff_code || s.username)}</a>${s.active ? '' : ' <span class="badge danger">khoá</span>'}</td>
          <td class="r num">${money(s.n)}</td><td class="r num">${money(s.tien)}</td><td class="r num">${money(s.tien_thu)}</td>
          <td><div class="bar" title="${pct(s.tien_thu, s.tien)}%"><span style="width:${pct(s.tien_thu, s.tien)}%"></span></div><span class="small muted">${pct(s.tien_thu, s.tien)}%</span></td>
          <td class="r num">${s.qua_han ? `<span class="badge danger">${s.qua_han}</span>` : 0}</td>
          <td class="r num">${s.thieu_ten} / ${s.thieu_sdt}</td>
          <td class="small">${s.last_login ? esc(utcToVN(s.last_login)) : '<span class="muted">chưa đăng nhập</span>'}</td>
          <td class="r num">${s.devices}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Chưa có tài khoản CTV.</td></tr>'}
        </tbody></table></div></div>
        <div><h2>Theo địa bàn <span class="muted small">(${d.byArea.length})</span></h2><div class="table-wrap" style="max-height:420px;overflow:auto"><table><thead><tr>
          <th>Tên địa bàn</th><th class="r">Thuê bao</th><th class="r">Tổng cước</th><th class="r">Đã thu</th><th>Tiến độ</th></tr></thead><tbody>
          ${d.byArea.map((a) => `<tr><td>${esc(a.dia_ban || '(trống)')}</td><td class="r num">${money(a.n)}</td><td class="r num">${money(a.tien)}</td><td class="r num">${money(a.tien_thu)}</td>
          <td><div class="bar"><span style="width:${pct(a.tien_thu, a.tien)}%"></span></div></td></tr>`).join('')}
        </tbody></table></div></div>
        <p class="muted small">Hôm nay: ${d.logins.ctv || 0} lượt CTV đăng nhập · ${d.logins.khach || 0} lượt khách đăng nhập · ${d.logins.fail || 0} lượt sai.</p>
      </div>`;
    const edit = (e) => { e.preventDefault(); editPeriod(d.period, route); };
    $('#editPeriod').onclick = edit;
    $('#editPeriod2') && ($('#editPeriod2').onclick = edit);
    $('#exportBtn').onclick = () => download('/api/admin/export.xlsx', `ket-qua-thu-${d.period.name}.xlsx`);
    $$('a[data-nv]').forEach((a) => (a.onclick = () => (custFilter = { ma_nv: a.dataset.nv })));
  };

  // Hộp thoại sửa kỳ thu cước – dùng ở Tổng quan và trang Kỳ thu cước
  function editPeriod(p, after) {
    const hanRieng = Number(p.han_rieng || 0);
    openDialog(
      `<h2>Sửa kỳ thu cước</h2>
       <div class="field"><label>Tên kỳ (khách thấy trong app & thông báo)</label><input name="name" value="${esc(p.name)}" maxlength="60" required></div>
       <div class="field"><label>Hạn thanh toán của kỳ (ngày/tháng/năm)</label>${DateField.html({ name: 'default_due', ymd: p.default_due })}</div>
       <div class="field"><label>Áp dụng hạn mới cho</label>
         <select name="due_scope">
           <option value="chung">Thuê bao đang dùng hạn chung / chưa có hạn</option>
           <option value="tat_ca">Tất cả thuê bao trong kỳ${hanRieng ? ` (kể cả ${money(hanRieng)} TB có hạn riêng)` : ''}</option>
         </select></div>
       <div class="field"><label>Ghi chú</label><input name="note" value="${esc(p.note || '')}" maxlength="300" placeholder="VD: Cước tháng 11, gia hạn đến 30/11"></div>
       ${p.is_current ? '<p class="small muted">Đây là kỳ hiện tại – khách & CTV đang xem kỳ này.</p>'
         : `<label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="make_current" style="width:auto;min-height:0"> Đặt làm kỳ hiện tại (khách & CTV sẽ xem kỳ này)</label>`}
       ${dlgButtons()}`,
      async (v) => {
        const r = await api(`/api/admin/periods/${p.id}`, { method: 'PUT', body: { ...v, make_current: v.make_current === 'on' } });
        toast(r.changed ? `Đã lưu – cập nhật hạn cho ${money(r.changed)} thuê bao` : 'Đã lưu');
        after();
      }
    );
  }

  // ---------------------------------------------------------- Thuê bao
  let custFilter = {};
  views['thue-bao'] = async () => {
    const f = await api('/api/admin/filters');
    const st = { q: '', dia_ban: '', ma_nv: '', status: '', page: 1, ...custFilter };
    custFilter = {};
    main.innerHTML = `
      <div class="page-head"><h1>Thuê bao</h1><button class="btn-primary" id="addCus">+ Thêm thuê bao</button></div>
      <div class="toolbar">
        <input id="fq" placeholder="Tìm Số TB, tên, SĐT, mã HĐ…" value="${esc(st.q)}">
        <select id="fnv"><option value="">Tất cả CTV</option>${f.staff.map((s) => `<option ${s === st.ma_nv ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select id="fdb"><option value="">Tất cả địa bàn</option>${f.areas.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
        <select id="fst">
          <option value="">Mọi trạng thái</option><option value="chua_thu">Chưa thu</option><option value="da_thu">Đã thu</option>
          <option value="qua_han">Quá hạn</option><option value="thieu_ten">Thiếu tên</option><option value="thieu_sdt">Thiếu SĐT</option>
        </select>
      </div>
      <div id="cusSum" class="muted small" style="margin-bottom:8px"></div>
      <div class="table-wrap"><table><thead><tr>
        <th>Tên KH</th><th>Số TB</th><th>Số ĐT liên hệ</th><th class="r">Tổng cước</th><th>Tên địa bàn</th><th>Mã CTV</th><th>Trạng thái</th><th></th>
      </tr></thead><tbody id="cusBody"></tbody></table></div>
      <div class="pager"><button id="prev" class="btn-sm">‹ Trước</button><span id="pinfo" class="small muted"></span><button id="next" class="btn-sm">Sau ›</button></div>`;
    let timer;
    const load = async () => {
      const qs = new URLSearchParams({ q: st.q, dia_ban: st.dia_ban, ma_nv: st.ma_nv, status: st.status, page: st.page, limit: 50 });
      const r = await api('/api/admin/customers?' + qs);
      const pages = Math.max(1, Math.ceil(r.total / r.limit));
      $('#cusSum').textContent = `${money(r.total)} thuê bao · ${money(r.totalMoney)}đ`;
      $('#pinfo').textContent = `Trang ${r.page}/${pages}`;
      $('#prev').disabled = r.page <= 1;
      $('#next').disabled = r.page >= pages;
      $('#cusBody').innerHTML =
        r.rows.map((c) => {
          const over = c.trang_thai === 'chua_thu' && c.han_tt && c.han_tt < r.today;
          return `<tr>
            <td>${c.ten_kh ? esc(c.ten_kh) : '<span class="badge warn">chưa có tên</span>'}</td>
            <td>${esc(c.ma_kh)}<div class="small muted">HĐ ${esc(c.ma_hd)}</div></td>
            <td>${c.sdt ? esc(c.sdt) : '<span class="badge warn">thiếu</span>'}</td>
            <td class="r num">${money(c.so_tien)}</td>
            <td class="small">${esc(c.dia_ban)}</td><td class="small">${esc(c.ma_nv)}</td>
            <td>${c.trang_thai === 'da_thu'
              ? `<span class="badge ok">Đã thu ${dmy(c.ngay_thu)}</span><div class="small muted">${{ file: 'tự động từ file', ctv: 'CTV ' + esc(c.thu_boi_ten || ''), admin: 'admin sửa' }[c.paid_source] || ''}</div>`
              : over ? '<span class="badge danger">Quá hạn</span>' : '<span class="badge">Chưa thu</span>'}</td>
            <td><button class="btn-sm" data-edit="${c.id}">Sửa</button></td></tr>`;
        }).join('') || '<tr><td colspan="8" class="muted">Không có thuê bao phù hợp.</td></tr>';
      $$('[data-edit]').forEach((b) => (b.onclick = () => editCustomer(r.rows.find((x) => x.id == b.dataset.edit), load)));
    };
    $('#fq').oninput = (e) => { clearTimeout(timer); timer = setTimeout(() => { st.q = e.target.value; st.page = 1; load(); }, 300); };
    $('#fnv').onchange = (e) => { st.ma_nv = e.target.value; st.page = 1; load(); };
    $('#fdb').onchange = (e) => { st.dia_ban = e.target.value; st.page = 1; load(); };
    $('#fst').onchange = (e) => { st.status = e.target.value; st.page = 1; load(); };
    $('#prev').onclick = () => { st.page--; load(); };
    $('#next').onclick = () => { st.page++; load(); };
    $('#addCus').onclick = () => editCustomer(null, load);
    await load();
  };

  function editCustomer(c, after) {
    const v = c || { trang_thai: 'chua_thu' };
    openDialog(
      `<h2>${c ? 'Sửa thuê bao' : 'Thêm thuê bao'}</h2>
      <div class="row">
        <div class="field"><label>Tên KH</label><input name="ten_kh" value="${esc(v.ten_kh)}"></div>
        <div class="field"><label>Số TB *</label><input name="ma_kh" value="${esc(v.ma_kh)}" required></div>
      </div>
      <div class="row" style="margin-top:12px">
        <div class="field"><label>Số ĐT liên hệ</label><input name="sdt" inputmode="tel" value="${esc(v.sdt)}"></div>
        <div class="field"><label>Tổng cước (đ)</label><input name="so_tien" inputmode="numeric" value="${esc(v.so_tien ?? '')}"></div>
      </div>
      <div class="row" style="margin-top:12px">
        <div class="field"><label>Mã CTV</label><input name="ma_nv" value="${esc(v.ma_nv)}"></div>
        <div class="field"><label>Mã hợp đồng</label><input name="ma_hd" value="${esc(v.ma_hd)}"></div>
      </div>
      <div class="field" style="margin-top:12px"><label>Tên địa bàn</label><input name="dia_ban" value="${esc(v.dia_ban)}"></div>
      <div class="row">
        <div class="field"><label>Loại thuê bao</label><input name="dich_vu" value="${esc(v.dich_vu)}"></div>
        <div class="field"><label>Hạn thanh toán</label>${DateField.html({ name: 'han_tt', ymd: v.han_tt })}</div>
        <div class="field"><label>Trạng thái</label><select name="trang_thai"><option value="chua_thu">Chưa thu</option><option value="da_thu" ${v.trang_thai === 'da_thu' ? 'selected' : ''}>Đã thu</option></select></div>
      </div>
      <div class="field" style="margin-top:12px"><label>Ghi chú</label><input name="ghi_chu" value="${esc(v.ghi_chu)}"></div>
      ${c ? '<button type="button" class="btn-sm btn-danger" id="delCus">Xoá thuê bao</button>' : ''}
      ${dlgButtons()}`,
      async (data) => {
        await api(c ? `/api/admin/customers/${c.id}` : '/api/admin/customers', { method: c ? 'PUT' : 'POST', body: data });
        toast('Đã lưu');
        after();
      }
    );
    if (c)
      $('#delCus').onclick = async () => {
        if (!confirm(`Xoá thuê bao ${c.ma_kh}?`)) return;
        await api(`/api/admin/customers/${c.id}`, { method: 'DELETE' });
        dlg.close();
        after();
      };
  }

  // ---------------------------------------------------------- Nhập dữ liệu
  views['nhap-du-lieu'] = async () => {
    const [s, periods] = await Promise.all([api('/api/admin/settings'), api('/api/admin/periods')]);
    const cur = periods.find((p) => p.is_current);
    const now = new Date();
    const defName = `Tháng ${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    main.innerHTML = `
      <div class="page-head"><h1>Nhập dữ liệu cước đầu kỳ</h1><button id="sampleBtn">Tải file mẫu</button></div>
      <div class="grid-2">
        <div class="card">
          <h2>Tuỳ chọn nhập</h2>
          <div class="field"><label>Cách nhập</label>
            <select id="imode">
              <option value="new">Tạo kỳ cước mới (đầu tháng)</option>
              <option value="update" ${cur ? '' : 'disabled'}>Cập nhật vào kỳ hiện tại${cur ? ` (${esc(cur.name)})` : ''} – giữ trạng thái đã thu</option>
            </select></div>
          <div class="row">
            <div class="field" id="pnameWrap"><label>Tên kỳ</label><input id="pname" value="${esc(defName)}"></div>
            <div class="field"><label>Hạn thanh toán của kỳ (ngày/tháng/năm)</label>${DateField.html({ id: 'pdue', ymd: cur?.default_due })}</div>
          </div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:12px;color:var(--text)"><input type="checkbox" id="pacc" style="width:auto;min-height:0">
            Tự tạo sẵn tài khoản cho Mã CTV mới (không cần nếu CTV tự đăng ký trên app)</label>
          <label id="pmissWrap" style="display:flex;gap:8px;align-items:flex-start;margin-top:10px;color:var(--text)"><input type="checkbox" id="pmiss" style="width:auto;min-height:0;margin-top:3px">
            <span>Tự đánh dấu <b>đã thanh toán</b> cho thuê bao <b>không còn trong file mới</b><br>
            <span class="small muted">Chỉ bật khi file mới là danh sách CÒN NỢ (ai trả rồi bị bỏ khỏi file). Thuê bao có cột Còn nợ = 0, Đã nộp đủ, hoặc Tổng cước về 0 luôn được tự đánh dấu.</span></span></label>
        </div>
        <div class="stack">
          <div class="card">
            <h2>Từ GitHub</h2>
            <div class="field"><label>Link file Excel trên GitHub</label>
              <input id="ghUrl" placeholder="https://github.com/ten/repo/blob/main/CUOC_T11.xlsx" value="${esc(s.github_url)}"></div>
            <p class="small muted">Repo riêng tư: nhập token trong mục <a href="#cai-dat">Cài đặt</a> (${s.github_token_set ? 'đã có token' : 'chưa có token'}).</p>
            <button class="btn-primary" id="ghBtn">Đồng bộ từ GitHub</button>
          </div>
          <div class="card">
            <h2>Hoặc tải file lên</h2>
            <input type="file" id="upFile" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
            <button id="upBtn" style="margin-top:10px">Nhập file</button>
          </div>
        </div>
      </div>
      <div id="impResult" style="margin-top:16px"></div>
      <p class="muted small" style="margin-top:16px">Đã có ${periods.length} kỳ cước. Sửa tên, hạn, đặt kỳ hiện tại hoặc xoá kỳ tại mục <a href="#ky-cuoc">Kỳ thu cước</a>.</p>`;
    const mode = $('#imode');
    mode.onchange = () => $('#pnameWrap').classList.toggle('hidden', mode.value === 'update');
    const opts = () => {
      const due = DateField.value($('#pdue'));
      if (due === null) throw new Error('Hạn thanh toán không hợp lệ – nhập theo dạng ngày/tháng/năm, vd 15/11/2026');
      return {
        mode: mode.value, periodName: $('#pname').value, defaultDue: due, createAccounts: $('#pacc').checked,
        markMissingPaid: mode.value === 'update' && $('#pmiss').checked,
      };
    };
    const syncMiss = () => $('#pmissWrap').classList.toggle('hidden', mode.value !== 'update');
    mode.addEventListener('change', syncMiss);
    syncMiss();
    const run = async (btn, fn) => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = 'Đang xử lý…';
      try { showImport(await fn()); } catch (e) { $('#impResult').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
      finally { btn.disabled = false; btn.textContent = old; }
    };
    $('#ghBtn').onclick = (e) => run(e.target, () => api('/api/admin/import/github', { body: { url: $('#ghUrl').value, ...opts() } }));
    $('#upBtn').onclick = (e) => {
      const file = $('#upFile').files[0];
      if (!file) return toast('Chọn file .xlsx trước');
      run(e.target, () => {
        const o = opts();
        const qs = new URLSearchParams({ ...o, createAccounts: o.createAccounts ? '1' : '0', markMissingPaid: o.markMissingPaid ? '1' : '0', filename: file.name });
        return api('/api/admin/import/upload?' + qs, { body: file, headers: { 'Content-Type': 'application/octet-stream' } });
      });
    };
    $('#sampleBtn').onclick = () => download('/api/admin/sample.xlsx', 'mau-file-cuoc.xlsx');
  };

  // ---------------------------------------------------------- Kỳ thu cước
  views['ky-cuoc'] = async () => {
    const periods = await api('/api/admin/periods');
    main.innerHTML = `
      <div class="page-head"><h1>Kỳ thu cước</h1><a class="btn btn-primary" href="#nhap-du-lieu">+ Nhập kỳ mới</a></div>
      <p class="muted small">Kỳ <b>hiện tại</b> là kỳ khách và CTV đang xem trên app. Bấm <b>Sửa</b> để đổi tên kỳ, hạn thanh toán, ghi chú hoặc đặt làm kỳ hiện tại.</p>
      <div class="table-wrap"><table><thead><tr>
        <th>Kỳ</th><th>Hạn thanh toán</th><th class="r">Thuê bao</th><th class="r">Tổng cước</th><th class="r">Đã thu</th><th>Tiến độ</th><th>Nguồn / ngày nhập</th>
      </tr></thead><tbody>
      ${periods.map((p) => `<tr>
        <td style="min-width:170px"><b>${esc(p.name)}</b> ${p.is_current ? '<span class="badge info">hiện tại</span>' : ''}
          ${p.note ? `<div class="small muted">${esc(p.note)}</div>` : ''}
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><button class="btn-sm btn-primary" data-edit="${p.id}">✏️ Sửa</button>
            ${p.is_current ? '' : `<button class="btn-sm" data-cur="${p.id}">Đặt hiện tại</button>`}
            <button class="btn-sm btn-danger" data-del="${p.id}">Xoá</button></div></td>
        <td>${p.default_due ? dmy(p.default_due) : '<span class="badge warn">chưa đặt</span>'}
          ${p.han_rieng ? `<div class="small muted">${money(p.han_rieng)} TB hạn riêng</div>` : ''}
          ${p.khong_han ? `<div class="small" style="color:var(--warn)">${money(p.khong_han)} TB chưa có hạn</div>` : ''}</td>
        <td class="r num">${money(p.n)}<div class="small muted">${p.so_ctv} CTV</div></td>
        <td class="r num">${money(p.tien)}</td>
        <td class="r num">${money(p.tien_thu)}<div class="small muted">${money(p.n_thu)} TB</div></td>
        <td><div class="bar"><span style="width:${pct(p.tien_thu, p.tien)}%"></span></div><span class="small muted">${pct(p.tien_thu, p.tien)}%</span></td>
        <td class="small">${esc(p.source.replace(/^upload:/, 'Tải lên: ').replace(/^github:/, 'GitHub: '))}<div class="muted">${esc(utcToVN(p.created_at))}</div></td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">Chưa có kỳ nào. <a href="#nhap-du-lieu">Nhập file cước</a></td></tr>'}
      </tbody></table></div>`;
    const find = (id) => periods.find((x) => x.id == id);
    $$('[data-edit]').forEach((b) => (b.onclick = () => editPeriod(find(b.dataset.edit), route)));
    $$('[data-cur]').forEach((b) => (b.onclick = async () => {
      const p = find(b.dataset.cur);
      if (!confirm(`Đặt "${p.name}" làm kỳ hiện tại? Khách và CTV sẽ chuyển sang xem kỳ này.`)) return;
      await api(`/api/admin/periods/${p.id}/current`, { body: {} });
      toast(`Kỳ hiện tại: ${p.name}`);
      route();
    }));
    $$('[data-del]').forEach((b) => (b.onclick = async () => {
      const p = find(b.dataset.del);
      if (!confirm(`Xoá kỳ "${p.name}" và toàn bộ ${money(p.n)} thuê bao (kể cả trạng thái đã thu) trong kỳ? Không thể hoàn tác.`)) return;
      try {
        const r = await api(`/api/admin/periods/${p.id}`, { method: 'DELETE' });
        toast(r.newCurrent ? `Đã xoá. Kỳ hiện tại chuyển sang: ${r.newCurrent.name}` : 'Đã xoá');
        route();
      } catch (e) { toast(e.message); }
    }));
  };

  function showImport(r) {
    $('#impResult').innerHTML = `
      <div class="card">
        <h2>Kết quả nhập · ${esc(r.period.name)}</h2>
        <div class="alert ok">Đọc ${money(r.total)} thuê bao, tổng cước ${money(r.totalMoney)}đ — thêm mới ${money(r.inserted)}, cập nhật ${money(r.updated)}${r.fromOverride ? `, áp ${r.fromOverride} tên CTV đã nhập tay` : ''}.</div>
        ${r.autoPaid || r.autoPaidMissing ? `<div class="alert ok">✓ Tự cập nhật <b>đã thanh toán</b>: ${money(r.autoPaid)} TB theo file (Còn nợ = 0 / Đã nộp đủ / Tổng cước về 0)${r.autoPaidMissing ? ` + ${money(r.autoPaidMissing)} TB không còn trong file nợ` : ''}.</div>` : ''}
        ${r.sheets.map((s) => `<div class="small muted">Sheet "${esc(s.name)}": ${s.skipped ? esc(s.reason) : `${s.rows} dòng · cột nhận được: ${s.columns.join(', ')}`}</div>`).join('')}
        ${r.warnings.map((w) => `<div class="alert warn">${esc(w)}</div>`).join('')}
        ${r.coverage.orphanCustomers ? `<div class="alert warn">${money(r.coverage.orphanCustomers)} thuê bao chưa có CTV phụ trách (Mã CTV: ${r.coverage.orphanGroups.map((g) => esc(g.ma_nv || 'trống')).filter((v, i, a) => a.indexOf(v) === i).join(', ')}).</div>` : ''}
        ${r.newAccounts.length ? `<p>Đã tạo <b>${r.newAccounts.length}</b> tài khoản CTV mới. <button class="btn-sm btn-primary" id="seeAcc">Xem mật khẩu</button></p>` : ''}
      </div>`;
    if (r.newAccounts.length) {
      $('#seeAcc').onclick = () => showSecret('Tài khoản CTV mới', r.newAccounts);
      showSecret('Tài khoản CTV mới', r.newAccounts);
    }
  }

  // ---------------------------------------------------------- Lịch thông báo
  views['lich-thong-bao'] = async () => {
    const [r, s] = await Promise.all([api('/api/admin/schedules'), api('/api/admin/settings')]);
    const today = r.now.slice(0, 10);
    const label = { khach: 'Khách hàng', ctv: 'CTV', ca_hai: 'Khách + CTV' };
    main.innerHTML = `
      <div class="page-head"><h1>Lịch thông báo</h1></div>
      <div class="grid-2">
        <div class="card">
          <h2>Thêm lịch gửi</h2>
          <div class="row">
            <div class="field"><label>Từ ngày</label>${DateField.html({ id: 'sFrom', ymd: today })}</div>
            <div class="field"><label>Đến ngày (bỏ trống = 1 ngày)</label>${DateField.html({ id: 'sTo' })}</div>
          </div>
          <div class="row" style="margin-top:12px">
            <div class="field"><label>Giờ gửi (cách nhau dấu phẩy)</label><input id="sTimes" value="08:00" placeholder="08:00, 17:30"></div>
            <div class="field"><label>Gửi cho</label><select id="sTarget"><option value="khach">Khách hàng chưa thanh toán</option><option value="ctv">CTV (tóm tắt)</option><option value="ca_hai">Cả hai</option></select></div>
          </div>
          <div class="field" style="margin-top:12px"><label>Nội dung riêng cho lịch này (bỏ trống = dùng mẫu chung bên phải)</label><textarea id="sMsg" placeholder="Có thể dùng {ten} {sotb} {sdt} {sotien} {diaban} {ky} {han}"></textarea></div>
          <div class="muted small" id="sCount"></div>
          <button class="btn-primary" id="sAdd" style="margin-top:8px">Thêm lịch</button>
        </div>
        <div class="card">
          <h2>Mẫu thông báo chung cho khách</h2>
          <p class="small muted">Dùng cho CTV chưa tự cài nội dung riêng trên app. Biến: <code>{ten}</code> <code>{sotb}</code> <code>{sdt}</code> <code>{sotien}</code> <code>{diaban}</code> <code>{ky}</code> <code>{han}</code>. Dòng "Vào nhóm… để được biết thông tin và hỗ trợ kịp thời" tự thêm ở cuối khi có link nhóm.</p>
          <textarea id="tpl" style="min-height:110px">${esc(s.customer_template)}</textarea>
          <h3 style="margin:14px 0 6px">Nhóm hỗ trợ (Tammi) – áp dụng cho tất cả khách</h3>
          <div class="row">
            <div class="field"><label>Link nhóm</label><input id="supUrl" value="${esc(s.support_url)}" placeholder="https://zalo.me/g/..." autocapitalize="off"></div>
            <div class="field"><label>Tên nhóm</label><input id="supName" value="${esc(s.support_name)}" placeholder="nhóm Tammi"></div>
          </div>
          ${s.support_url ? '' : '<div class="alert warn" style="margin-top:8px">Chưa có link nhóm → khách <b>không thấy</b> nút “Vào nhóm Tammi”. Dán link nhóm vào ô trên rồi bấm Lưu.</div>'}
          <div class="small muted" style="margin:10px 0 4px">Xem trước (dữ liệu thật của 1 thuê bao):</div>
          <div class="alert ok" id="tplPrev" style="white-space:pre-wrap;margin-bottom:6px"></div>
          <div id="tplBtnPrev" style="margin-bottom:12px"></div>
          <button id="tplSave" class="btn-primary">Lưu nội dung & link nhóm</button>
          <p class="small muted" style="margin-top:12px">Khách đã được CTV đánh dấu "đã thu" sẽ không nhận thông báo. Chỉ khách đã cài app và bật thông báo mới nhận được.</p>
        </div>
      </div>
      <h2 style="margin-top:24px">Danh sách lịch</h2>
      <div class="table-wrap"><table><thead><tr><th>Thời gian</th><th>Gửi cho</th><th>Nội dung</th><th>Trạng thái</th><th></th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr>
        <td class="num">${esc(x.send_at.slice(11))} ${dmy(x.send_at.slice(0, 10))}</td>
        <td>${x.owner_id ? `Khách của <b>${esc(x.owner_code || x.owner_name)}</b><div class="small muted">CTV tự đặt</div>` : label[x.target]}</td>
        <td class="small">${x.message ? esc(x.message) : '<span class="muted">mẫu chung</span>'}</td>
        <td class="small">${x.status === 'cho' ? '<span class="badge info">Chờ gửi</span>' : x.status === 'da_gui' ? `<span class="badge ok">Đã gửi</span> ${esc(x.result)}` : `<span class="badge danger">Lỗi</span> ${esc(x.result)}`}</td>
        <td style="white-space:nowrap"><button class="btn-sm" data-run="${x.id}">Gửi ngay</button> <button class="btn-sm btn-danger" data-sdel="${x.id}">Xoá</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Chưa có lịch nào.</td></tr>'}
      </tbody></table></div>`;

    const buildTimes = () => {
      const from = DateField.value($('#sFrom'));
      const to = DateField.value($('#sTo')) || from;
      const hours = $('#sTimes').value.split(/[,;\s]+/).map((h) => h.trim()).filter(Boolean)
        .map((h) => { const m = h.match(/^(\d{1,2})(?:[:hg](\d{2}))?$/i); return m ? `${m[1].padStart(2, '0')}:${m[2] || '00'}` : null; });
      if (!from || $('#sTo').value.trim() && !to || hours.some((h) => !h)) return null;
      const out = [];
      for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z') && out.length < 61; d.setUTCDate(d.getUTCDate() + 1))
        for (const h of hours) out.push(`${d.toISOString().slice(0, 10)} ${h}`);
      return out;
    };
    const upd = () => { const t = buildTimes(); $('#sCount').textContent = t ? `${t.length} lần gửi` : 'Kiểm tra ngày (ngày/tháng/năm) và giờ (vd 08:00)'; };
    ['#sFrom', '#sTo', '#sTimes'].forEach((s) => ($(s).oninput = upd));
    upd();
    $('#sAdd').onclick = async () => {
      const times = buildTimes();
      if (!times?.length) return toast('Kiểm tra ngày/giờ');
      if (times.length > 60) return toast('Tối đa 60 lần gửi mỗi lần thêm');
      try {
        await api('/api/admin/schedules', { body: { times, target: $('#sTarget').value, message: $('#sMsg').value } });
        toast(`Đã thêm ${times.length} lịch`);
        route();
      } catch (e) { toast(e.message); }
    };
    let pt;
    // Xem trước: nội dung + dòng "Vào nhóm…" + nút nhóm (theo link đang gõ, chưa cần lưu)
    const prev = async () => {
      const p = await api('/api/admin/notify-preview', {
        body: { message: $('#tpl').value, support_url: $('#supUrl').value, support_name: $('#supName').value },
      });
      $('#tplPrev').textContent = p.body;
      $('#tplBtnPrev').innerHTML = p.support
        ? `<span class="btn" style="background:#0068ff;border-color:#0068ff;color:#fff;font-weight:600;pointer-events:none">💬 Vào ${esc(p.support.name)}</span> <span class="small muted">← khách thấy nút này</span>`
        : '<span class="small muted">(Chưa có link nhóm – khách sẽ không thấy nút vào nhóm)</span>';
    };
    ['#tpl', '#supUrl', '#supName'].forEach((s) => ($(s).oninput = () => { clearTimeout(pt); pt = setTimeout(prev, 300); }));
    prev();
    $('#tplSave').onclick = async (e) => {
      e.target.disabled = true;
      try {
        await api('/api/admin/settings', {
          method: 'PUT',
          body: { customer_template: $('#tpl').value, support_url: $('#supUrl').value, support_name: $('#supName').value },
        });
        toast('Đã lưu – áp dụng cho tất cả khách');
        route();
      } catch (ex) { toast(ex.message, 5000); }
      finally { e.target.disabled = false; }
    };
    $$('[data-run]').forEach((b) => (b.onclick = async () => {
      if (!confirm('Gửi thông báo này ngay bây giờ?')) return;
      b.disabled = true;
      try { const x = await api(`/api/admin/schedules/${b.dataset.run}/run`, { body: {} }); toast(x.result || 'Đã gửi', 5000); route(); }
      catch (e) { toast(e.message); b.disabled = false; }
    }));
    $$('[data-sdel]').forEach((b) => (b.onclick = async () => { await api(`/api/admin/schedules/${b.dataset.sdel}`, { method: 'DELETE' }); route(); }));
  };

  // ---------------------------------------------------------- Duyệt đăng ký CTV
  views['duyet'] = async () => {
    const st = { status: 'cho' };
    main.innerHTML = `<div class="page-head"><h1>Duyệt đăng ký CTV</h1>
      <select id="rgSt" style="width:auto"><option value="cho">Chờ duyệt</option><option value="duyet">Đã duyệt</option><option value="tu_choi">Đã từ chối</option></select></div>
      <p class="muted small">CTV đăng ký trên app (tab Cộng tác viên → Đăng ký CTV). Duyệt xong, CTV đăng nhập bằng Mã CTV + mật khẩu đã tự đặt và chỉ thấy thuê bao có đúng Mã CTV đó.</p>
      <div id="rgList"></div>`;
    const load = async () => {
      const r = await api('/api/admin/registrations?status=' + st.status);
      $('#rgList').innerHTML = r.rows.length
        ? `<div class="stack">${r.rows.map((g) => {
            const warn = [];
            if (!g.customer_count) warn.push('<div class="alert warn">Mã CTV này <b>không có</b> trong file cước kỳ hiện tại – kiểm tra lại có gõ đúng mã không.</div>');
            if (g.existing?.last_login) warn.push(`<div class="alert warn">Mã này <b>đã có tài khoản đang dùng</b> (${esc(g.existing.full_name || g.existing.username)}${g.existing.phone ? ' · ' + esc(g.existing.phone) : ''}, đăng nhập gần nhất ${esc(utcToVN(g.existing.last_login))}). Duyệt sẽ <b>đổi mật khẩu</b> và đăng xuất người đang dùng – chỉ duyệt nếu chắc đúng người.</div>`);
            else if (g.existing) warn.push('<div class="small muted">Đã có tài khoản tạo sẵn (chưa ai đăng nhập) – duyệt sẽ gán mật khẩu của người đăng ký.</div>');
            return `<div class="card">
              <div class="page-head" style="margin-bottom:8px"><div>
                <h2 style="margin:0">${esc(g.staff_code)}</h2>
                <div class="small muted">Gửi lúc ${esc(utcToVN(g.created_at))} · IP ${esc(g.ip)}</div></div>
                ${g.customer_count ? `<span class="badge ok">${money(g.customer_count)} thuê bao trong file</span>` : '<span class="badge danger">không có trong file</span>'}
              </div>
              <div class="row" style="align-items:start">
                <div class="field"><label>Họ tên</label><b>${esc(g.full_name)}</b></div>
                <div class="field"><label>SĐT</label><b><a href="tel:${esc(g.phone)}">${esc(g.phone)}</a></b></div>
                <div class="field"><label>Thiết bị</label><span class="small muted">${esc(g.user_agent.slice(0, 90))}</span></div>
              </div>
              ${warn.join('')}
              ${g.status === 'cho'
                ? `<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn-primary" data-ok="${g.id}">✓ Duyệt</button><button class="btn-danger" data-no="${g.id}">Từ chối</button></div>`
                : `<div class="small muted" style="margin-top:8px">${g.status === 'duyet' ? '<span class="badge ok">Đã duyệt</span>' : '<span class="badge danger">Đã từ chối</span>'} bởi ${esc(g.decided_by_name || '—')} lúc ${esc(utcToVN(g.decided_at))}${g.note ? ' · Lý do: ' + esc(g.note) : ''}</div>`}
            </div>`;
          }).join('')}</div>`
        : `<div class="card muted">${st.status === 'cho' ? 'Không có đơn nào đang chờ duyệt.' : 'Chưa có.'}</div>`;
      $$('[data-ok]').forEach((b) => (b.onclick = async () => {
        const g = r.rows.find((x) => x.id == b.dataset.ok);
        const msg = g.existing?.last_login
          ? `Mã ${g.staff_code} đang có người dùng. Duyệt sẽ đổi mật khẩu và đăng xuất họ. Chắc chắn duyệt cho ${g.full_name}?`
          : `Duyệt tài khoản ${g.staff_code} cho ${g.full_name}?`;
        if (!confirm(msg)) return;
        b.disabled = true;
        try { await api(`/api/admin/registrations/${g.id}/approve`, { body: {} }); toast(`Đã duyệt ${g.staff_code}`); load(); refreshRegBadge(); }
        catch (e) { toast(e.message); b.disabled = false; }
      }));
      $$('[data-no]').forEach((b) => (b.onclick = () => {
        const g = r.rows.find((x) => x.id == b.dataset.no);
        openDialog(
          `<h2>Từ chối ${esc(g.staff_code)}</h2><div class="field"><label>Lý do (CTV sẽ thấy khi đăng nhập)</label><input name="note" placeholder="VD: Sai Mã CTV"></div>${dlgButtons('Từ chối')}`,
          async (v) => { await api(`/api/admin/registrations/${g.id}/reject`, { body: v }); toast('Đã từ chối'); load(); refreshRegBadge(); }
        );
      }));
    };
    $('#rgSt').onchange = (e) => { st.status = e.target.value; load(); };
    await load();
  };

  // ---------------------------------------------------------- Tài khoản CTV
  views['ctv'] = async () => {
    const users = await api('/api/admin/users');
    main.innerHTML = `
      <div class="page-head"><h1>Tài khoản CTV</h1><button class="btn-primary" id="addUser">+ Thêm tài khoản</button></div>
      <p class="muted small">CTV đăng nhập app bằng <b>Mã CTV</b> và mật khẩu, và chỉ thấy thuê bao có đúng Mã CTV đó trong file cước.</p>
      <div class="table-wrap"><table><thead><tr><th>Mã CTV / tên đăng nhập</th><th>Họ tên</th><th>Vai trò</th><th class="r">Thuê bao kỳ này</th><th>Đăng nhập gần nhất</th><th class="r">Thiết bị</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr>
        <td><b>${esc(u.staff_code || u.username)}</b>${u.staff_code && u.staff_code !== u.username ? `<div class="small muted">đăng nhập: ${esc(u.username)}</div>` : ''}${u.areas ? `<div class="small muted">+ địa bàn: ${esc(u.areas)}</div>` : ''}</td>
        <td>${esc(u.full_name)}${u.phone ? `<div class="small muted">${esc(u.phone)}</div>` : ''}</td>
        <td>${u.role === 'admin' ? '<span class="badge info">Quản trị</span>' : 'CTV'} ${u.active ? '' : '<span class="badge danger">Khoá</span>'}</td>
        <td class="r num">${u.role === 'admin' ? '<span class="muted">tất cả</span>' : money(u.customer_count)}</td>
        <td class="small">${u.last_login ? esc(utcToVN(u.last_login)) : '<span class="muted">chưa</span>'}</td>
        <td class="r num">${u.devices}</td>
        <td style="white-space:nowrap"><button class="btn-sm" data-u="${u.id}">Sửa</button> <button class="btn-sm" data-rs="${u.id}">Cấp lại MK</button></td></tr>`).join('')}
      </tbody></table></div>`;
    $('#addUser').onclick = () => editUser(null);
    $$('[data-u]').forEach((b) => (b.onclick = () => editUser(users.find((u) => u.id == b.dataset.u))));
    $$('[data-rs]').forEach((b) => (b.onclick = async () => {
      const u = users.find((x) => x.id == b.dataset.rs);
      if (!confirm(`Cấp mật khẩu mới cho ${u.username}? Mật khẩu cũ sẽ không dùng được nữa.`)) return;
      try { showSecret('Mật khẩu mới', [await api(`/api/admin/users/${u.id}/reset-password`, { body: {} })]); } catch (e) { toast(e.message); }
    }));
  };

  function editUser(u) {
    const v = u || { role: 'staff', active: true };
    openDialog(
      `<h2>${u ? 'Sửa tài khoản' : 'Thêm tài khoản CTV'}</h2>
      <div class="row">
        <div class="field"><label>Mã CTV (khớp cột Mã CTV trong file)</label><input name="staff_code" value="${esc(v.staff_code)}" placeholder="VD: DUOCNT_QNI_CNKD"></div>
        <div class="field"><label>Tên đăng nhập *</label><input name="username" value="${esc(v.username)}" required pattern="[A-Za-z0-9._\\-]{3,40}" placeholder="thường = Mã CTV"></div>
      </div>
      <div class="row" style="margin-top:12px">
        <div class="field"><label>Họ tên</label><input name="full_name" value="${esc(v.full_name)}"></div>
        <div class="field"><label>SĐT</label><input name="phone" value="${esc(v.phone)}"></div>
      </div>
      <div class="field" style="margin-top:12px"><label>Giao thêm địa bàn (không bắt buộc, cách nhau dấu phẩy)</label><input name="areas" value="${esc(v.areas)}"></div>
      <div class="row">
        <div class="field"><label>${u ? 'Mật khẩu mới (bỏ trống = giữ nguyên)' : 'Mật khẩu *'}</label><input name="password" type="text" autocomplete="new-password" ${u ? '' : 'required minlength="6"'}></div>
        <div class="field"><label>Vai trò</label><select name="role"><option value="staff">CTV</option><option value="admin" ${v.role === 'admin' ? 'selected' : ''}>Quản trị</option></select></div>
        <div class="field"><label>Trạng thái</label><select name="active"><option value="1">Hoạt động</option><option value="0" ${v.active ? '' : 'selected'}>Khoá</option></select></div>
      </div>
      ${u && u.id !== me.id ? '<button type="button" class="btn-sm btn-danger" id="delUser" style="margin-top:12px">Xoá tài khoản</button>' : ''}
      ${dlgButtons()}`,
      async (d) => {
        if (!d.username && d.staff_code) d.username = d.staff_code;
        d.active = d.active === '1';
        await api(u ? `/api/admin/users/${u.id}` : '/api/admin/users', { method: u ? 'PUT' : 'POST', body: d });
        toast('Đã lưu');
        route();
      }
    );
    const sc = $('#dlgForm [name=staff_code]');
    const un = $('#dlgForm [name=username]');
    if (!u) sc.oninput = () => { un.value = sc.value.trim(); };
    if ($('#delUser'))
      $('#delUser').onclick = async () => {
        if (!confirm(`Xoá tài khoản ${u.username}?`)) return;
        await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
        dlg.close();
        route();
      };
  }

  // ---------------------------------------------------------- Nhật ký đăng nhập
  views['dang-nhap'] = async () => {
    const st = { client: '', result: '', page: 1 };
    main.innerHTML = `<div class="page-head"><h1>Nhật ký đăng nhập</h1></div><div id="logWrap"></div>`;
    const clientLabel = { admin: 'Quản trị', ctv: 'CTV', khach: 'Khách hàng', app: 'App' };
    const load = async () => {
      const r = await api('/api/admin/login-logs?' + new URLSearchParams(st));
      const pages = Math.max(1, Math.ceil(r.total / 50));
      $('#logWrap').innerHTML = `
        <div class="kpis">
          <div class="card kpi"><div class="label">Khách đăng nhập (30 ngày)</div><div class="value num">${money(r.customers.tb)}</div><div class="sub">${money(r.customers.ok)} lượt · ${money(r.customers.fail)} lượt sai</div></div>
          <div class="card kpi"><div class="label">CTV hoạt động (30 ngày)</div><div class="value num">${r.perUser.filter((u) => u.role === 'staff' && u.ok).length}/${r.perUser.filter((u) => u.role === 'staff').length}</div></div>
        </div>
        <h2>CTV trong 30 ngày</h2>
        <div class="table-wrap"><table><thead><tr><th>Tài khoản</th><th class="r">Lượt đăng nhập</th><th class="r">Số ngày hoạt động</th><th class="r">Lượt sai</th><th>Lần cuối</th></tr></thead><tbody>
        ${r.perUser.map((u) => `<tr><td>${esc(u.staff_code || u.username)} ${u.role === 'admin' ? '<span class="badge info">QT</span>' : ''}</td><td class="r num">${u.ok || 0}</td><td class="r num">${u.days_active || 0}</td>
          <td class="r num">${u.fail ? `<span class="badge danger">${u.fail}</span>` : 0}</td><td class="small">${u.last_ok ? esc(utcToVN(u.last_ok)) : '<span class="muted">—</span>'}</td></tr>`).join('')}
        </tbody></table></div>
        <h2 style="margin-top:20px">Chi tiết</h2>
        <div class="toolbar">
          <select id="lc"><option value="">Mọi loại</option><option value="ctv">CTV</option><option value="khach">Khách hàng</option><option value="admin">Quản trị</option></select>
          <select id="lr"><option value="">Mọi kết quả</option><option value="ok">Thành công</option><option value="fail">Thất bại</option></select>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Thời gian</th><th>Loại</th><th>Tài khoản / Số TB</th><th>Kết quả</th><th class="r">TB được cấp</th><th>IP</th><th>Thiết bị</th></tr></thead><tbody>
        ${r.rows.map((l) => `<tr><td class="small">${esc(utcToVN(l.at))}</td><td>${clientLabel[l.client] || esc(l.client)}</td><td>${esc(l.username)}</td>
          <td>${l.success ? '<span class="badge ok">Thành công</span>' : `<span class="badge danger">${esc(l.reason || 'Thất bại')}</span>`}</td>
          <td class="r num">${l.customer_count ?? ''}</td><td class="small">${esc(l.ip)}</td><td class="small muted" style="max-width:260px">${esc(l.user_agent.slice(0, 80))}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Chưa có.</td></tr>'}
        </tbody></table></div>
        <div class="pager"><button id="lp" class="btn-sm" ${r.page <= 1 ? 'disabled' : ''}>‹ Trước</button><span class="small muted">Trang ${r.page}/${pages}</span><button id="ln" class="btn-sm" ${r.page >= pages ? 'disabled' : ''}>Sau ›</button></div>`;
      $('#lc').value = st.client;
      $('#lr').value = st.result;
      $('#lc').onchange = (e) => { st.client = e.target.value; st.page = 1; load(); };
      $('#lr').onchange = (e) => { st.result = e.target.value; st.page = 1; load(); };
      $('#lp').onclick = () => { st.page--; load(); };
      $('#ln').onclick = () => { st.page++; load(); };
    };
    await load();
  };

  // ---------------------------------------------------------- Cài đặt
  views['cai-dat'] = async () => {
    const s = await api('/api/admin/settings');
    main.innerHTML = `
      <div class="page-head"><h1>Cài đặt</h1></div>
      <div class="grid-2">
        <form class="card" id="ghForm">
          <h2>GitHub</h2>
          <div class="field"><label>Link file Excel</label><input name="github_url" value="${esc(s.github_url)}" placeholder="https://github.com/ten/repo/blob/main/CUOC_T11.xlsx"></div>
          <div class="field"><label>Token (repo riêng tư) ${s.github_token_set ? '<span class="badge ok">đã lưu</span>' : ''}</label>
            <input name="github_token" type="password" autocomplete="off" placeholder="${s.github_token_set ? 'Giữ nguyên token đã lưu' : 'github_pat_… (chỉ cần quyền Contents: Read)'}"></div>
          <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="auto_sync" ${s.auto_sync ? 'checked' : ''} style="width:auto;min-height:0"> Tự đồng bộ mỗi sáng (cập nhật kỳ hiện tại, giữ trạng thái đã thu)</label>
          <label style="display:flex;gap:8px;align-items:flex-start;color:var(--text);margin-top:8px"><input type="checkbox" name="auto_mark_paid" ${s.auto_mark_paid ? 'checked' : ''} style="width:auto;min-height:0;margin-top:3px">
            <span>Khi tự đồng bộ: thuê bao <b>không còn trong file</b> → tự đánh dấu đã thanh toán<br><span class="small muted">Bật nếu file trên GitHub được cập nhật thành danh sách CÒN NỢ mỗi ngày.</span></span></label>
          <div style="display:flex;gap:8px;margin-top:12px"><button class="btn-primary">Lưu</button>${s.github_token_set ? '<button type="button" id="clrTok" class="btn-danger">Xoá token</button>' : ''}</div>
        </form>
        <form class="card" id="ctvForm">
          <h2>Nhắc CTV</h2>
          <label style="display:flex;gap:8px;align-items:center;color:var(--text)"><input type="checkbox" name="ctv_daily" ${s.ctv_daily ? 'checked' : ''} style="width:auto;min-height:0"> Mỗi sáng gửi CTV tóm tắt số thuê bao chưa thu</label>
          <div class="row" style="margin-top:12px">
            <div class="field"><label>Giờ gửi CTV</label><input name="remind_hour" type="number" min="5" max="22" value="${s.remind_hour}"></div>
            <div class="field"><label>"Sắp đến hạn" = trước hạn (ngày)</label><input name="remind_days_before" type="number" min="0" max="30" value="${s.remind_days_before}"></div>
          </div>
          <div class="field" style="margin-top:12px"><label>Mẫu tin CTV gửi khách (SMS/Zalo) – <code>{link}</code> là link riêng của khách</label><textarea name="sms_template">${esc(s.sms_template)}</textarea></div>
          <button class="btn-primary">Lưu</button>
        </form>
        <form class="card" id="supForm">
          <h2>Khách hàng</h2>
          <div class="row">
            <div class="field"><label>Tên nhóm hỗ trợ</label><input name="support_name" value="${esc(s.support_name)}" placeholder="VD: Nhóm Tammi hỗ trợ"></div>
            <div class="field"><label>Link nhóm hỗ trợ (Zalo…)</label><input name="support_url" value="${esc(s.support_url)}" placeholder="https://zalo.me/g/..."></div>
          </div>
          <p class="small muted">Hiện thành nút “Vào nhóm…” trong khung nhắc cước trên màn hình khách.</p>
          <div class="field"><label>Địa chỉ web công khai của app (dùng tạo link gửi khách)</label>
            <input name="public_url" value="${esc(s.public_url)}" placeholder="${esc(s.detected_url)}">
            <div class="small muted">Để trống = tự lấy (${esc(s.detected_url)}). Khi đưa lên mạng, nhập tên miền thật, vd https://nhaccuoc.ten-mien.vn</div></div>
          <button class="btn-primary">Lưu</button>
        </form>
        <form class="card" id="pwForm">
          <h2>Đổi mật khẩu của tôi</h2>
          <div class="field"><label>Mật khẩu hiện tại</label><input name="oldPassword" type="password" autocomplete="current-password" required></div>
          <div class="field"><label>Mật khẩu mới</label><input name="newPassword" type="password" autocomplete="new-password" minlength="6" required></div>
          <button class="btn-primary">Đổi mật khẩu</button>
        </form>
      </div>`;
    const save = (body, msg = 'Đã lưu') => api('/api/admin/settings', { method: 'PUT', body }).then(() => toast(msg)).catch((e) => toast(e.message));
    $('#ghForm').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      save({ github_url: f.get('github_url'), github_token: f.get('github_token'), auto_sync: f.has('auto_sync'), auto_mark_paid: f.has('auto_mark_paid') }).then(route);
    };
    $('#clrTok') && ($('#clrTok').onclick = () => save({ clear_github_token: true }, 'Đã xoá token').then(route));
    $('#ctvForm').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      save({ ctv_daily: f.has('ctv_daily'), remind_hour: f.get('remind_hour'), remind_days_before: f.get('remind_days_before'), sms_template: f.get('sms_template') });
    };
    $('#supForm').onsubmit = (e) => {
      e.preventDefault();
      save(Object.fromEntries(new FormData(e.target)));
    };
    $('#pwForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/me/password', { body: Object.fromEntries(new FormData(e.target)) });
        toast('Đã đổi mật khẩu');
        e.target.reset();
      } catch (ex) { toast(ex.message); }
    };
  };

  start();
})();
