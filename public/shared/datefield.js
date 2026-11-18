// Ô nhập ngày kiểu Việt Nam: ngày/tháng/năm (dd/mm/yyyy) + nút 📅 mở lịch.
// Thay cho <input type="date"> vì ô ngày của trình duyệt đi theo ngôn ngữ máy
// (máy để tiếng Anh sẽ là tháng/ngày/năm → gõ "15" vào ô tháng bị đổi thành 12).
(() => {
  const pad = (n) => String(n).padStart(2, '0');
  const escAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ymdToDmy = (ymd) => (ymd && /^\d{4}-\d{2}-\d{2}/.test(ymd) ? ymd.slice(0, 10).split('-').reverse().join('/') : '');

  const DateField = {
    /** HTML của ô ngày. ymd: giá trị ban đầu dạng YYYY-MM-DD */
    html({ name = '', id = '', ymd = '', required = false } = {}) {
      return `<span class="datef"><input type="text" ${id ? `id="${escAttr(id)}"` : ''} ${name ? `name="${escAttr(name)}"` : ''}
        value="${ymdToDmy(ymd)}" placeholder="ngày/tháng/năm" inputmode="numeric" autocomplete="off" maxlength="10"
        ${required ? 'required' : ''} data-datef><button type="button" class="datef-btn" aria-label="Chọn ngày trên lịch">📅</button><input
        type="date" class="datef-native" tabindex="-1" aria-hidden="true"></span>`;
    },
    /** "15/11/2026" → "2026-11-15"; ngày không có thật → null */
    toYMD(text) {
      const m = String(text || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return null;
      const s = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
      const d = new Date(s + 'T00:00:00Z');
      return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
    },
    /** Giá trị YYYY-MM-DD của ô (rỗng → '', sai → null) */
    value(el) {
      return el.value.trim() ? this.toYMD(el.value) : '';
    },
    set(el, ymd) {
      el.value = ymdToDmy(ymd);
      check(el);
    },
  };

  function check(el) {
    const bad = el.value.trim() && !DateField.toYMD(el.value);
    el.setCustomValidity(bad ? 'Ngày không hợp lệ – nhập theo dạng ngày/tháng/năm, vd 15/11/2026' : '');
    el.classList.toggle('datef-bad', !!bad);
  }

  // Gõ số tự chèn dấu "/" : 15 → 15/ , 1511 → 15/11/ , 15112026 → 15/11/2026
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches('[data-datef]')) return;
    if (e.inputType && e.inputType.startsWith('delete')) return check(el);
    // gộp "//" (ô đã tự chèn "/" mà người dùng gõ thêm "/") và bỏ "/" ở đầu
    const parts = el.value.replace(/[^\d/]/g, '').replace(/\/{2,}/g, '/').replace(/^\//, '').split('/');
    const out = [];
    for (let i = 0; i < parts.length && out.length < 3; i++) {
      let p = parts[i];
      if (out.length < 2 && p.length > 2) {
        parts.splice(i + 1, 0, p.slice(2));
        p = p.slice(0, 2);
      }
      if (out.length === 2) p = p.slice(0, 4);
      out.push(p);
    }
    let v = out.join('/');
    if (out.length < 3 && /^\d{2}$/.test(out[out.length - 1]) && e.data !== '/') v += '/';
    el.value = v;
    check(el);
  });
  // Rời ô: chuẩn hoá 1/5/2026 → 01/05/2026
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches('[data-datef]')) return;
    const ymd = DateField.toYMD(el.value);
    if (ymd) el.value = ymdToDmy(ymd);
    check(el);
  });
  // Nút 📅 → mở lịch của trình duyệt (chọn bằng lịch thì không phụ thuộc thứ tự ngày/tháng)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.datef-btn');
    if (!btn) return;
    const box = btn.closest('.datef');
    const text = box.querySelector('[data-datef]');
    const nat = box.querySelector('.datef-native');
    nat.value = DateField.toYMD(text.value) || '';
    try {
      if (nat.showPicker) nat.showPicker();
      else nat.click();
    } catch {
      text.focus();
    }
  });
  document.addEventListener('change', (e) => {
    const nat = e.target;
    if (!nat.classList || !nat.classList.contains('datef-native')) return;
    const text = nat.closest('.datef').querySelector('[data-datef]');
    text.value = ymdToDmy(nat.value);
    check(text);
    text.dispatchEvent(new Event('input', { bubbles: true }));
    text.dispatchEvent(new Event('change', { bubbles: true }));
  });

  window.DateField = DateField;
})();
