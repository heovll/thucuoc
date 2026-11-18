// App điện thoại: khách hàng xem cước + nhận nhắc; CTV quản lý thuê bao của mình.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (n) => Number(n || 0).toLocaleString('vi-VN');
  const dmy = (ymd) => (ymd ? ymd.slice(0, 10).split('-').reverse().join('/') : '');
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  const KEY = 'tc_app_session';
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch {} },
  };
  let session = store.get();

  async function api(path, body, method) {
    const headers = {};
    if (session?.token) headers.Authorization = 'Bearer ' + session.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !/login$/.test(path)) {
      session = null;
      store.set(null);
      show('vLogin');
      throw new Error(data.error || 'Phiên đăng nhập đã hết hạn.');
    }
    if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
    return data;
  }
  function toast(msg, ms = 3000) {
    const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
    document.body.append(t);
    setTimeout(() => t.remove(), ms);
  }
  function show(id) {
    ['vLogin', 'vKh', 'vCtv', 'vCtvSet'].forEach((v) => $('#' + v).classList.toggle('hidden', v !== id));
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------ Service worker & thông báo
  let swReg = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((r) => (swReg = r)).catch(() => {});
  }
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64ToU8 = (b64) => {
    const p = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  // Chờ service worker tối đa 4 giây – không treo giao diện nếu trình duyệt lỗi
  const swReady = () =>
    swReg ? Promise.resolve(swReg)
      : Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('Trình duyệt chưa sẵn sàng nhận thông báo. Tải lại trang rồi thử lại.')), 4000))]);
  async function currentSub() {
    if (!pushSupported()) return null;
    const reg = await swReady();
    return reg.pushManager.getSubscription();
  }
  async function enablePush() {
    if (!pushSupported()) throw new Error('Trình duyệt này không hỗ trợ thông báo.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Bạn chưa cho phép thông báo. Vào Cài đặt của trình duyệt để bật lại.');
    const reg = await swReady();
    const { publicKey } = await api('/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
    await api('/api/push/subscribe', { subscription: sub.toJSON() });
    return sub;
  }
  // Ô trạng thái thông báo dùng chung cho khách & CTV
  async function renderNotify(el, who) {
    const text = who === 'kh'
      ? 'Bật thông báo để được nhắc thanh toán cước đúng hạn.'
      : 'Bật thông báo để nhận tóm tắt thuê bao cần thu mỗi ngày.';
    if (isIOS && !standalone) {
      el.innerHTML = `<div class="card notice"><div class="ic">📲</div><div><b>Cài app để nhận thông báo</b>
        <p class="small">Trên iPhone: bấm nút <b>Chia sẻ</b> <span aria-hidden="true">⎋</span> ở thanh Safari → chọn <b>“Thêm vào MH chính”</b>, rồi mở app từ màn hình chính.</p></div></div>`;
      return;
    }
    if (!pushSupported()) {
      el.innerHTML = `<div class="alert warn">Trình duyệt này không hỗ trợ thông báo. Hãy mở bằng Chrome (Android) hoặc Safari (iPhone).</div>`;
      return;
    }
    const sub = await currentSub().catch(() => null);
    if (sub && Notification.permission === 'granted') {
      // đồng bộ lại với máy chủ (phòng khi đăng nhập tài khoản khác trên cùng máy)
      api('/api/push/subscribe', { subscription: sub.toJSON() }).catch(() => {});
      el.innerHTML = `<div class="card notice"><div class="ic">🔔</div><div><b>Đã bật thông báo</b>
        <p class="small muted">Bạn sẽ nhận nhắc theo lịch hệ thống.</p><button class="btn-sm" id="testPush">Gửi thử</button></div></div>`;
      $('#testPush', el).onclick = async () => {
        try { await api('/api/push/test', { endpoint: sub.endpoint }); toast('Đã gửi – kiểm tra thông báo trên máy'); } catch (e) { toast(e.message); }
      };
      return;
    }
    el.innerHTML = `<div class="card notice"><div class="ic">🔕</div><div><b>Chưa bật thông báo</b><p class="small">${text}</p>
      <button class="btn-primary btn-sm" id="onPush">Bật thông báo</button></div></div>`;
    $('#onPush', el).onclick = async (e) => {
      e.target.disabled = true;
      try { await enablePush(); toast('Đã bật thông báo'); renderNotify(el, who); } catch (ex) { toast(ex.message, 5000); e.target.disabled = false; }
    };
  }

  // ------------------------------------------------ Cài app (Android)
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvt = e;
    $('#btnInstall').classList.remove('hidden');
  });
  $('#btnInstall').onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => {});
    installEvt = null;
    $('#btnInstall').classList.add('hidden');
  };

  // ------------------------------------------------ Đăng nhập
  // Các khung trong màn hình đăng nhập: kh | ctv | reg | regDone
  function loginPane(p) {
    $$('.seg button').forEach((x) => x.classList.toggle('on', x.dataset.tab === (p === 'kh' ? 'kh' : 'ctv')));
    $('#fKh').classList.toggle('hidden', p !== 'kh');
    $('#fCtv').classList.toggle('hidden', p !== 'ctv');
    $('#fReg').classList.toggle('hidden', p !== 'reg');
    $('#regDone').classList.toggle('hidden', p !== 'regDone');
  }
  $$('.seg button').forEach((b) => (b.onclick = () => loginPane(b.dataset.tab)));
  $('#toReg').onclick = (e) => { e.preventDefault(); loginPane('reg'); };
  $('#toLogin').onclick = (e) => { e.preventDefault(); loginPane('ctv'); };
  $('#regDoneBtn').onclick = () => loginPane('ctv');
  $('#fReg').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = Object.fromEntries(new FormData(form));
    const err = $('[data-err]', form);
    const btn = $('button', form);
    err.classList.add('hidden');
    if (f.password !== f.password2) {
      err.textContent = 'Hai lần nhập mật khẩu không khớp.';
      return err.classList.remove('hidden');
    }
    btn.disabled = true;
    try {
      await api('/api/register', { staff_code: f.staff_code, full_name: f.full_name, phone: f.phone, password: f.password });
      $('#regDoneCode').textContent = f.staff_code.trim().toUpperCase();
      $('#ctvU').value = f.staff_code.trim().toUpperCase();
      form.reset();
      loginPane('regDone');
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  };
  async function doLogin(form, path, body) {
    const err = $('[data-err]', form);
    const btn = $('button', form);
    err.classList.add('hidden');
    btn.disabled = true;
    try {
      const r = await api(path, body);
      session = { token: r.token, kind: r.kind, user: r.user || null };
      store.set(session);
      form.reset();
      route();
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  }
  $('#fKh').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    doLogin(e.target, '/api/customer/login', { tra_cuu: f.get('tra_cuu') });
  };
  $('#fCtv').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    doLogin(e.target, '/api/login', { username: f.get('username'), password: f.get('password'), client: 'ctv' });
  };
  $$('[data-logout]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Đăng xuất khỏi app? Máy này sẽ ngừng nhận thông báo.')) return;
    const sub = await currentSub().catch(() => null);
    await api('/api/logout', { endpoint: sub?.endpoint || '' }).catch(() => {});
    if (sub) await sub.unsubscribe().catch(() => {});
    session = null;
    store.set(null);
    show('vLogin');
  }));

  // ------------------------------------------------ Màn hình khách hàng
  async function loadCustomer() {
    show('vKh');
    renderNotify($('#khNotify'), 'kh');
    const r = await api('/api/customer/me');
    $('#khPeriod').textContent = r.period ? `Kỳ cước ${r.period.name}` : '';
    if (!r.bills.length) {
      $('#khBills').innerHTML = '<div class="card empty">Chưa có thông tin cước kỳ này cho thuê bao của bạn.</div>';
    } else {
      $('#khBills').innerHTML = r.bills.map((b) => {
        const over = !b.da_thanh_toan && b.han_tt && b.han_tt < r.today;
        const badge = b.da_thanh_toan
          ? '<span class="badge ok">Đã thanh toán</span>'
          : over ? '<span class="badge danger">Quá hạn thanh toán</span>' : '<span class="badge warn">Chưa thanh toán</span>';
        return `<article class="card bill ${b.da_thanh_toan ? 'paid' : over ? 'over' : ''}">
          <div class="status-line">${badge}${b.han_tt && !b.da_thanh_toan ? `<span class="small muted">Hạn: ${dmy(b.han_tt)}</span>` : ''}</div>
          <div class="small muted">Tổng cước</div>
          <div class="amount num">${money(b.tong_cuoc)}đ</div>
          <dl>
            <dt>Tên KH</dt><dd>${esc(b.ten_kh || '—')}</dd>
            <dt>Số TB</dt><dd>${esc(b.so_tb)}</dd>
            <dt>Số ĐT liên hệ</dt><dd>${esc(b.sdt || '—')}</dd>
            <dt>Tên địa bàn</dt><dd>${esc(b.dia_ban || '—')}</dd>
          </dl>
        </article>`;
      }).join('');
    }
    // Ô "Thông báo": nội dung nhắc + nút vào nhóm hỗ trợ + lịch nhắc sắp tới
    const unpaid = r.bills.some((b) => !b.da_thanh_toan);
    $('#khMsg').classList.toggle('hidden', !r.reminder && !r.support);
    $('#khMsgBody').textContent = r.reminder ? r.reminder.body : (r.bills.length ? 'Quý khách đã thanh toán cước kỳ này. Xin cảm ơn!' : '');
    $('#khMsgBody').classList.toggle('hidden', !$('#khMsgBody').textContent);
    $('#khNext').textContent = unpaid && r.upcoming?.length
      ? 'Lịch nhắc: ' + r.upcoming.map((t) => `${t.slice(11)} ${dmy(t.slice(0, 10)).slice(0, 5)}`).join(' · ') : '';
    const sup = $('#khSupport');
    sup.classList.toggle('hidden', !r.support?.url);
    if (r.support?.url) { sup.href = r.support.url; $('span', sup).textContent = `Vào ${r.support.name}`; }
    if (r.reminder && !popupShown) {
      popupShown = true;
      showPopup(r.reminder, r.support);
    }
  }

  // Khung nhắc cước hiện ngay khi khách mở app (mỗi lần mở 1 lần), có ✕ đóng + link nhóm hỗ trợ
  let popupShown = false;
  let popupAt = 0;
  async function showPopup(rem, support) {
    const pop = $('#popup');
    popupAt = Date.now();
    $('#popTitle').textContent = rem.title;
    $('#popBody').textContent = rem.body;
    const sl = $('#popSupport');
    sl.classList.toggle('hidden', !support?.url);
    if (support?.url) { sl.href = support.url; $('span', sl).textContent = `Vào ${support.name}`; }
    const pb = $('#popPush');
    const canPush = pushSupported() && !(isIOS && !standalone);
    pb.classList.toggle('hidden', !canPush);
    // Hiện khung ngay, không chờ kiểm tra thông báo (trình duyệt chậm/lỗi vẫn hiện)
    if (!pop.open) pop.showModal();
    if (canPush) currentSub().then((sub) => { if (sub && Notification.permission === 'granted') pb.classList.add('hidden'); }).catch(() => {});
    pb.onclick = async () => {
      pb.disabled = true;
      try { await enablePush(); toast('Đã bật thông báo'); pb.classList.add('hidden'); renderNotify($('#khNotify'), 'kh'); }
      catch (e) { toast(e.message, 5000); }
      finally { pb.disabled = false; }
    };
  }
  $('#popX').onclick = () => $('#popup').close();
  $('#popClose').onclick = () => $('#popup').close();
  $('#popup').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }); // bấm ra ngoài để đóng

  // ------------------------------------------------ Màn hình CTV
  const ctv = { all: [], filter: 'chua_thu', q: '', area: '', shown: 60, today: '', tpl: '', period: '' };
  async function loadCtv() {
    show('vCtv');
    renderNotify($('#ctvNotify'), 'ctv');
    $('#ctvName').textContent = session.user?.staff_code || session.user?.username || 'CTV';
    const r = await api('/api/my/customers');
    ctv.all = r.customers;
    ctv.today = r.today;
    ctv.tpl = r.smsTemplate;
    ctv.period = r.period?.name || '';
    $('#ctvPeriod').textContent = r.period ? `Kỳ cước ${r.period.name} · ${money(r.customers.length)} thuê bao` : 'Chưa có dữ liệu kỳ cước';
    const areas = [...new Set(ctv.all.map((c) => c.dia_ban).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
    $('#ctvArea').innerHTML = '<option value="">Mọi địa bàn</option>' + areas.map((a) => `<option>${esc(a)}</option>`).join('');
    $('#ctvArea').value = areas.includes(ctv.area) ? ctv.area : '';
    renderCtv();
  }
  const isMissing = (c) => !c.ten_kh || !c.sdt;
  function renderCtv() {
    const all = ctv.all;
    const unpaid = all.filter((c) => c.trang_thai === 'chua_thu');
    const paid = all.length - unpaid.length;
    const sumUnpaid = unpaid.reduce((s, c) => s + c.so_tien, 0);
    const sumPaid = all.reduce((s, c) => s + (c.trang_thai === 'da_thu' ? c.so_tien : 0), 0);
    $('#ctvSum').innerHTML = `
      <div class="card"><div class="v num">${money(unpaid.length)}</div><div class="l">Chưa thu · ${money(sumUnpaid)}đ</div></div>
      <div class="card"><div class="v num" style="color:var(--ok)">${money(paid)}</div><div class="l">Đã thu · ${money(sumPaid)}đ</div></div>
      <div class="card"><div class="v num" style="color:var(--warn)">${money(all.filter(isMissing).length)}</div><div class="l">Thiếu tên/SĐT</div></div>`;
    const counts = { chua_thu: unpaid.length, thieu: all.filter(isMissing).length, da_thu: paid, all: all.length };
    $$('#ctvTabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.f === ctv.filter);
      b.innerHTML = `${b.textContent.replace(/\s*\(\d[\d.]*\)$/, '')} <span class="cnt">(${money(counts[b.dataset.f])})</span>`;
    });
    const q = fold(ctv.q.trim());
    let list = all.filter((c) =>
      (ctv.filter === 'all' || (ctv.filter === 'thieu' ? isMissing(c) : c.trang_thai === ctv.filter)) &&
      (!ctv.area || c.dia_ban === ctv.area) &&
      (!q || fold(`${c.ten_kh} ${c.ma_kh} ${c.sdt} ${c.ma_hd}`).includes(q))
    );
    const total = list.length;
    list = list.slice(0, ctv.shown);
    $('#ctvList').innerHTML = list.map(cardHtml).join('') || '<div class="card empty">Không có thuê bao phù hợp.</div>';
    $('#ctvMore').classList.toggle('hidden', total <= ctv.shown);
    $('#ctvMore').textContent = `Xem thêm (${money(total - ctv.shown)})`;
  }
  function msgText(c) {
    // {han} chỉ là ngày; mẫu kiểu cũ "han{han}" (dính liền) tự thêm "truoc ngay"
    const tpl = String(ctv.tpl || '')
      .replace(/hạn\{han\}/g, c.han_tt ? 'hạn trước ngày {han}' : 'hạn')
      .replace(/han\{han\}/g, c.han_tt ? 'han truoc ngay {han}' : 'han');
    let text = tpl.replace(/\{(\w+)\}/g, (m, k) => ({
      ten: c.ten_kh || 'Quy khach', sotb: c.ma_kh, sdt: c.sdt, sotien: money(c.so_tien), diaban: c.dia_ban, ky: ctv.period,
      han: c.han_tt ? dmy(c.han_tt) : '', mactv: c.ma_nv, link: c.link || '',
    })[k] ?? m);
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/(trước ngày|truoc ngay|tháng|thang|kỳ|ky|ngày|ngay)\s+\1(?=[\s\d])/giu, '$1');
    if (c.link && !text.includes(c.link)) text += ` ${c.link}`; // mẫu cũ không có {link} vẫn kèm link
    return text;
  }
  const smsHref = (c) => `sms:${c.sdt}${isIOS ? '&' : '?'}body=${encodeURIComponent(msgText(c))}`;
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: t });
      document.body.append(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }
  }
  // Gửi link cho khách: dùng bảng chia sẻ của điện thoại (Zalo, Messenger, SMS…), không có thì sao chép
  async function shareLink(c) {
    const text = msgText(c);
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    if (await copyText(text)) toast('Đã sao chép tin nhắn kèm link – dán vào Zalo/SMS để gửi khách', 4000);
  }
  function cardHtml(c) {
    const paid = c.trang_thai === 'da_thu';
    const over = !paid && c.han_tt && c.han_tt < ctv.today;
    return `<article class="card cus ${paid ? 'paid' : ''}" data-id="${c.id}">
      <div class="h">
        <div style="min-width:0">
          <div class="name">${c.ten_kh ? esc(c.ten_kh) : '<span class="missing">Chưa có tên – bấm Sửa để nhập</span>'}</div>
          <div class="meta">Số TB: <b>${esc(c.ma_kh)}</b> · SĐT: ${c.sdt ? `<b>${esc(c.sdt)}</b>` : '<span class="missing">chưa có</span>'}</div>
          <div class="meta">${esc(c.dia_ban)} · Mã CTV: ${esc(c.ma_nv)}</div>
          ${c.ghi_chu ? `<div class="meta">📝 ${esc(c.ghi_chu)}</div>` : ''}
        </div>
        <div style="text-align:right"><div class="money num">${money(c.so_tien)}đ</div>
          ${paid ? `<span class="badge ok">Đã thu ${dmy(c.ngay_thu).slice(0, 5)}</span>` : over ? '<span class="badge danger">Quá hạn</span>' : '<span class="badge">Chưa thu</span>'}</div>
      </div>
      <div class="acts">
        ${c.sdt ? `<a class="btn" href="tel:${esc(c.sdt)}">📞 Gọi</a><a class="btn" href="${esc(smsHref(c))}">💬 SMS</a><button data-act="zalo">Zalo</button>` : ''}
        ${c.link ? '<button data-act="share">📤 Gửi link</button>' : ''}
        <button data-act="edit">✏️ Sửa</button>
        ${paid ? '<button data-act="undo">Hoàn tác</button>' : '<button data-act="paid" class="btn-ok">✓ Đã thu</button>'}
      </div>
    </article>`;
  }
  async function updateCustomer(id, body) {
    const updated = await api(`/api/my/customers/${id}`, body);
    const i = ctv.all.findIndex((x) => x.id === id);
    if (i >= 0) ctv.all[i] = updated;
    renderCtv();
    return updated;
  }
  $('#ctvList').onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id);
    const c = ctv.all.find((x) => x.id === id);
    try {
      if (btn.dataset.act === 'paid') { btn.disabled = true; await updateCustomer(id, { trang_thai: 'da_thu' }); toast(`Đã thu ${c.ma_kh}`); }
      if (btn.dataset.act === 'undo') { await updateCustomer(id, { trang_thai: 'chua_thu' }); }
      if (btn.dataset.act === 'edit') editCustomer(c);
      if (btn.dataset.act === 'share') shareLink(c);
      if (btn.dataset.act === 'zalo') {
        // Zalo không cho điền sẵn nội dung → sao chép tin nhắn trước, mở khung chat, CTV chỉ việc dán
        await copyText(msgText(c));
        toast('Đã sao chép tin nhắn – dán vào khung chat Zalo', 3500);
        window.open(`https://zalo.me/${encodeURIComponent(c.sdt)}`, '_blank', 'noopener');
      }
    } catch (ex) { toast(ex.message); btn.disabled = false; }
  };
  function editCustomer(c) {
    const form = $('#dlgForm');
    form.innerHTML = `
      <h2>Thuê bao ${esc(c.ma_kh)}</h2>
      <p class="small muted" style="margin-top:-4px">${esc(c.dia_ban)} · ${money(c.so_tien)}đ</p>
      <div class="field"><label>Tên KH</label><input name="ten_kh" value="${esc(c.ten_kh)}" placeholder="Nhập tên khách hàng"></div>
      <div class="field"><label>Số ĐT liên hệ</label><input name="sdt" type="tel" inputmode="tel" value="${esc(c.sdt)}" placeholder="VD: 0912345678"></div>
      <div class="field"><label>Ghi chú</label><input name="ghi_chu" value="${esc(c.ghi_chu)}" placeholder="VD: hẹn thu chiều thứ 6"></div>
      <p class="small muted">Tên và SĐT bạn nhập sẽ được giữ cho các kỳ sau.</p>
      <div class="alert error hidden" data-err></div>
      <div class="dlg-actions"><button value="cancel" formnovalidate>Huỷ</button><button value="ok" class="btn-primary">Lưu</button></div>`;
    $('#dlg').showModal();
    form.onsubmit = async (e) => {
      if (e.submitter?.value !== 'ok') return;
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      try {
        await updateCustomer(c.id, f);
        $('#dlg').close();
        toast('Đã lưu');
      } catch (ex) {
        const er = $('[data-err]', form);
        er.textContent = ex.message;
        er.classList.remove('hidden');
      }
    };
  }
  // ------------------------------------------------ CTV: cài đặt thông báo
  const set = { info: null, hours: new Set(['08:00']) };
  $('#toSet').onclick = () => openSettings();
  $('#backList').onclick = () => { show('vCtv'); };
  async function openSettings() {
    show('vCtvSet');
    try {
      set.info = await api('/api/my/notify');
    } catch (e) { return toast(e.message); }
    const i = set.info;
    $('#stTpl').value = i.customer_template;
    $('#stTpl').placeholder = 'Để trống = dùng nội dung chung:\n' + i.defaults.customer_template;
    $('#stUrl').value = i.support_url;
    $('#stUrl').placeholder = i.defaults.support_url || 'https://zalo.me/g/...';
    $('#stName').value = i.support_name;
    $('#stName').placeholder = i.defaults.support_name || 'nhóm Tammi';
    if (!$('#scFrom').value) DateField.set($('#scFrom'), i.now.slice(0, 10));
    renderSchedules();
    updateSchedSum();
    previewMsg();
  }
  let pvT;
  async function previewMsg() {
    const name = $('#stName').value.trim() || set.info?.defaults.support_name || 'nhóm Tammi';
    $('#stLine').textContent = `“${(set.info?.defaults.support_line || '').replace(/\{nhom\}/g, name)}”`;
    try {
      const p = await api('/api/my/notify/preview', { customer_template: $('#stTpl').value, support_url: $('#stUrl').value, support_name: $('#stName').value });
      $('#stPrev').textContent = p.body;
    } catch {}
  }
  ['#stTpl', '#stUrl', '#stName'].forEach((s) => ($(s).oninput = () => { clearTimeout(pvT); pvT = setTimeout(previewMsg, 350); }));
  $('#varChips').onclick = (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    const ta = $('#stTpl');
    if (!ta.value) ta.value = set.info?.defaults.customer_template || '';
    const p = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, p) + v + ta.value.slice(ta.selectionEnd ?? p);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = p + v.length;
    previewMsg();
  };
  $('#stSave').onclick = async (e) => {
    const err = $('#stErr');
    err.classList.add('hidden');
    e.target.disabled = true;
    try {
      set.info = await api('/api/my/notify', { customer_template: $('#stTpl').value, support_url: $('#stUrl').value, support_name: $('#stName').value }, 'PUT');
      toast('Đã lưu – áp dụng cho tất cả khách của bạn');
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    finally { e.target.disabled = false; }
  };

  // Lịch: Từ ngày + Số lần + Cách nhau + các khung giờ
  function renderHourChips() {
    const box = $('#hourChips');
    for (const h of set.hours) if (!$(`[data-h="${h}"]`, box)) box.insertAdjacentHTML('beforeend', `<button type="button" data-h="${h}">${h}</button>`);
    [...box.children].sort((a, b) => a.dataset.h.localeCompare(b.dataset.h)).forEach((b) => box.append(b));
    $$('button', box).forEach((b) => b.classList.toggle('on', set.hours.has(b.dataset.h)));
  }
  $('#hourChips').onclick = (e) => {
    const h = e.target.closest('button')?.dataset.h;
    if (!h) return;
    set.hours.has(h) ? set.hours.delete(h) : set.hours.add(h);
    renderHourChips();
    updateSchedSum();
  };
  $('#scAddHour').onclick = () => {
    const v = $('#scCustom').value;
    if (!/^\d{2}:\d{2}$/.test(v)) return toast('Chọn giờ trước');
    set.hours.add(v);
    $('#scCustom').value = '';
    renderHourChips();
    updateSchedSum();
  };
  function buildTimes() {
    const from = DateField.value($('#scFrom'));
    const n = Math.min(30, Math.max(1, parseInt($('#scTimes').value, 10) || 1));
    const gap = Math.min(15, Math.max(1, parseInt($('#scGap').value, 10) || 1));
    if (!from || !set.hours.size) return [];
    const out = [];
    const d = new Date(from + 'T00:00:00Z');
    for (let k = 0; k < n; k++, d.setUTCDate(d.getUTCDate() + gap))
      for (const h of [...set.hours].sort()) out.push(`${d.toISOString().slice(0, 10)} ${h}`);
    const now = set.info?.now || '';
    return out.filter((t) => t >= now);
  }
  function updateSchedSum() {
    const t = buildTimes();
    $('#scSum').textContent = t.length
      ? `Sẽ hiển thị ${t.length} lần: ${t.slice(0, 4).map((x) => `${x.slice(11)} ${dmy(x.slice(0, 10)).slice(0, 5)}`).join(', ')}${t.length > 4 ? '…' : ''}`
      : 'Chọn ngày và ít nhất 1 giờ (thời điểm phải ở tương lai).';
  }
  ['#scFrom', '#scTimes', '#scGap'].forEach((s) => ($(s).oninput = updateSchedSum));
  $('#scAdd').onclick = async (e) => {
    const times = buildTimes();
    const err = $('#scErr');
    err.classList.add('hidden');
    if (!times.length) { err.textContent = 'Chưa có thời điểm hợp lệ.'; return err.classList.remove('hidden'); }
    if (times.length > 60) { err.textContent = 'Tối đa 60 lần mỗi lần đặt – giảm số lần hoặc số giờ.'; return err.classList.remove('hidden'); }
    e.target.disabled = true;
    try {
      const r = await api('/api/my/schedules', { times });
      toast(`Đã đặt ${r.added} lần nhắc${r.skipped ? ` (bỏ qua ${r.skipped} trùng)` : ''}`);
      set.info = await api('/api/my/notify');
      renderSchedules();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
    finally { e.target.disabled = false; }
  };
  function renderSchedules() {
    const rows = set.info?.schedules || [];
    $('#scDev').textContent = `${set.info?.devices || 0} khách đã bật thông báo`;
    const pending = rows.filter((r) => r.status === 'cho');
    const done = rows.filter((r) => r.status !== 'cho').slice(-5).reverse();
    $('#scList').innerHTML =
      (pending.length
        ? pending.map((r) => `<div class="sch"><div><b class="num">${r.send_at.slice(11)}</b> · ${dmy(r.send_at.slice(0, 10))}</div>
            <button class="btn-sm btn-danger" data-del="${r.id}">Xoá</button></div>`).join('')
        : '<div class="small muted">Chưa có lịch chờ gửi.</div>') +
      (done.length
        ? `<div class="small muted" style="margin-top:10px">Đã gửi gần đây:</div>` +
          done.map((r) => `<div class="small muted">• ${r.send_at.slice(11)} ${dmy(r.send_at.slice(0, 10))} – ${esc(r.result || (r.status === 'loi' ? 'lỗi' : 'đã gửi'))}</div>`).join('')
        : '');
  }
  $('#scList').onclick = async (e) => {
    const id = e.target.closest('[data-del]')?.dataset.del;
    if (!id) return;
    try { await api(`/api/my/schedules/${id}`, undefined, 'DELETE'); set.info = await api('/api/my/notify'); renderSchedules(); }
    catch (ex) { toast(ex.message); }
  };
  $('#scNow').onclick = async (e) => {
    if (!confirm('Gửi thông báo ngay bây giờ cho tất cả khách CHƯA thanh toán (đã bật thông báo)?')) return;
    e.target.disabled = true;
    try {
      const r = await api('/api/my/notify/send-now', {});
      toast(`Đã gửi ${r.sent} thông báo (${r.devices} máy khách, bỏ qua ${r.paidSkipped} đã thanh toán)`, 5000);
      set.info = await api('/api/my/notify');
      renderSchedules();
    } catch (ex) { toast(ex.message, 5000); }
    finally { e.target.disabled = false; }
  };

  $$('#ctvTabs button').forEach((b) => (b.onclick = () => { ctv.filter = b.dataset.f; ctv.shown = 60; renderCtv(); }));
  let qt;
  $('#ctvQ').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { ctv.q = e.target.value; ctv.shown = 60; renderCtv(); }, 200); };
  $('#ctvArea').onchange = (e) => { ctv.area = e.target.value; ctv.shown = 60; renderCtv(); };
  $('#ctvMore').onclick = () => { ctv.shown += 100; renderCtv(); };

  // ------------------------------------------------ Khởi động
  async function route() {
    // Khách mở link riêng (…/app/#k=TOKEN) → vào thẳng, không phải nhập gì
    const k = new URLSearchParams(location.hash.slice(1)).get('k');
    if (k) {
      history.replaceState(null, '', location.pathname); // xoá token khỏi thanh địa chỉ
      try {
        const r = await api('/api/customer/link', { k });
        session = { token: r.token, kind: r.kind, user: null };
        store.set(session);
      } catch (e) {
        if (!session?.token) {
          show('vLogin');
          const err = $('#fKh [data-err]');
          err.textContent = e.message;
          err.classList.remove('hidden');
          return;
        }
      }
    }
    if (!session?.token) return show('vLogin');
    try {
      if (session.kind === 'customer') await loadCustomer();
      else await loadCtv();
    } catch (e) {
      if (session) toast(e.message, 5000);
    }
  }
  // Mở lại app từ nền → làm mới dữ liệu
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !session) return;
    if (!$('#vCtvSet').classList.contains('hidden')) return; // đang cài đặt → không làm mất nội dung đang gõ
    // mở lại app sau hơn 1 giờ → hiện lại khung nhắc nếu còn nợ cước (quay lại ngay từ Zalo thì không làm phiền)
    if (Date.now() - popupAt > 3600e3) popupShown = false;
    route();
  });
  window.addEventListener('hashchange', () => { if (location.hash.includes('k=')) { popupShown = false; route(); } });
  route();
})();
