'use strict';
// PITUPITA Confirm-Dialog — einheitlich über alle Apps
// Usage: const ok = await pitupitaConfirm({ title, message, confirmText, cancelText, danger });

(function () {
  let _resolver = null;

  function ensureDialog() {
    if (document.getElementById('pp-confirm')) return;
    const wrap = document.createElement('div');
    wrap.id = 'pp-confirm';
    wrap.className = 'pp-confirm-overlay hidden';
    wrap.innerHTML = `
      <div class="pp-confirm-box">
        <div class="pp-confirm-icon" id="pp-confirm-icon"></div>
        <div class="pp-confirm-content">
          <div class="pp-confirm-title" id="pp-confirm-title"></div>
          <div class="pp-confirm-message" id="pp-confirm-message"></div>
        </div>
        <div class="pp-confirm-actions">
          <button class="pp-confirm-cancel" id="pp-confirm-cancel" type="button"></button>
          <button class="pp-confirm-ok" id="pp-confirm-ok" type="button"></button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', e => { if (e.target === wrap) close(false); });
    document.getElementById('pp-confirm-cancel').addEventListener('click', () => close(false));
    document.getElementById('pp-confirm-ok').addEventListener('click', () => close(true));
    document.addEventListener('keydown', e => {
      if (wrap.classList.contains('hidden')) return;
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    });
  }

  function close(result) {
    const wrap = document.getElementById('pp-confirm');
    if (wrap) wrap.classList.add('hidden');
    if (_resolver) { _resolver(result); _resolver = null; }
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/\n/g, '<br>');
  }

  window.pitupitaConfirm = function (opts) {
    ensureDialog();
    const o = opts || {};
    const danger = !!o.danger;
    const title = o.title || 'Bestätigen';
    const message = o.message || '';
    const confirmText = o.confirmText || (danger ? 'Löschen' : 'Bestätigen');
    const cancelText = o.cancelText || 'Abbrechen';

    document.getElementById('pp-confirm-title').textContent = title;
    document.getElementById('pp-confirm-message').innerHTML = escHtml(message);
    const okBtn = document.getElementById('pp-confirm-ok');
    okBtn.textContent = confirmText;
    okBtn.classList.toggle('danger', danger);
    document.getElementById('pp-confirm-cancel').textContent = cancelText;
    const icon = document.getElementById('pp-confirm-icon');
    icon.className = 'pp-confirm-icon ' + (danger ? 'danger' : 'info');
    icon.innerHTML = danger
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

    document.getElementById('pp-confirm').classList.remove('hidden');
    setTimeout(() => okBtn.focus(), 50);

    return new Promise(resolve => { _resolver = resolve; });
  };
})();
