'use strict';

const socket = io();
let alleReklamationen = [];
let aktuellerFilter   = 'aktiv';
let userName  = localStorage.getItem('rekla_username') || '';
let userRole  = localStorage.getItem('rekla_userrole') || '';
let detailOpenId  = null;
let aktionReklaId = null;
let aktionSchritt = null;
let neuBilder = [];

// ── INITIALISIERUNG ───────────────────────────────────────
function initBilderDropzone() {
  const zone  = document.getElementById('n-bilder-zone');
  const input = document.getElementById('n-bilder');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    addNeuBilder([...e.dataTransfer.files].filter(f => f.type.startsWith('image/')));
  });
  zone.addEventListener('click', e => { if (e.target !== input && e.target.htmlFor !== 'n-bilder') input.click(); });
  input.addEventListener('change', () => { addNeuBilder([...input.files]); input.value = ''; });
}

function addNeuBilder(files) {
  neuBilder.push(...files);
  renderNeuBilderVorschau();
}

function removeNeuBild(index) {
  neuBilder.splice(index, 1);
  renderNeuBilderVorschau();
}

function renderNeuBilderVorschau() {
  const container = document.getElementById('n-bilder-preview');
  if (!container) return;
  container.innerHTML = neuBilder.map((f, i) => {
    const url = URL.createObjectURL(f);
    return `<div class="vorschau-item">
      <img src="${url}" alt="${escHtml(f.name)}" />
      <button type="button" onclick="removeNeuBild(${i})" title="Entfernen">×</button>
    </div>`;
  }).join('');
}

window.addEventListener('DOMContentLoaded', async () => {
  const backBtn = document.getElementById('portal-back-btn');
  if (backBtn) {
    fetch('/api/config').then(r => r.json()).then(cfg => {
      backBtn.href = `http://${window.location.hostname}:${cfg.portalPort}`;
    });
  }

  initBilderDropzone();

  // Portal-Session prüfen
  try {
    const meRes = await fetch('/api/me');
    if (meRes.ok) {
      const me = await meRes.json();
      if (me.name) {
        userName = me.name;
        userRole = 'lager';
        localStorage.setItem('rekla_user', me.name);
        localStorage.setItem('rekla_role', 'lager');
      }
    }
  } catch {}

  // Session prüfen — wenn keine aktive Session, Modal offen lassen
  try {
    const res = await fetch('/api/reklamationen');
    if (res.status === 401) {
      zeigeLoginModal();
      return;
    }
    // Angemeldet
    if (userName && userRole) {
      closeUserModal();
      updateUserDisplay();
    }
    document.getElementById('btn-neu').classList.remove('hidden');
    document.getElementById('btn-export').classList.remove('hidden');
    const daten = await res.json();
    alleReklamationen = daten;
    renderListe();
    ladeStatistik();
  } catch {
    toast('Fehler beim Laden', 'error');
  }

  document.getElementById('user-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') setUser();
  });
  document.getElementById('user-passwort-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') setUser();
  });
  document.getElementById('user-name-btn').addEventListener('touchend', e => {
    e.preventDefault(); setUser();
  });
});

function zeigeLoginModal() {
  document.getElementById('user-modal').classList.remove('hidden');
}

// ── USER / ROLLE ──────────────────────────────────────────
async function setUser() {
  const passwort = document.getElementById('user-passwort-input').value;
  const name     = document.getElementById('user-name-input').value.trim();
  if (!passwort) { shake(document.getElementById('user-passwort-input')); return; }
  if (!name)     { shake(document.getElementById('user-name-input'));     return; }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwort })
    });
    if (!res.ok) {
      shake(document.getElementById('user-passwort-input'));
      document.getElementById('user-passwort-input').value = '';
      toast('Falsches Passwort', 'error');
      return;
    }
  } catch {
    toast('Verbindungsfehler', 'error');
    return;
  }

  const role = document.querySelector('input[name="user-role"]:checked')?.value || 'kundenservice';
  userName = name;
  userRole = role;
  localStorage.setItem('rekla_username', userName);
  localStorage.setItem('rekla_userrole', userRole);
  closeUserModal();
  updateUserDisplay();
  document.getElementById('btn-neu').classList.remove('hidden');
  document.getElementById('btn-export').classList.remove('hidden');
  document.getElementById('btn-logout').classList.remove('hidden');
  ladeReklamationen();
  ladeStatistik();
}

function closeUserModal() {
  document.getElementById('user-modal').classList.add('hidden');
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  document.getElementById('btn-neu').classList.add('hidden');
  document.getElementById('btn-export').classList.add('hidden');
  document.getElementById('btn-logout').classList.add('hidden');
  document.getElementById('user-passwort-input').value = '';
  alleReklamationen = [];
  renderListe();
  document.getElementById('user-modal').classList.remove('hidden');
}

function changeUser() {
  document.getElementById('user-name-input').value = userName;
  const radioEl = document.querySelector(`input[name="user-role"][value="${userRole}"]`);
  if (radioEl) radioEl.checked = true;
  document.getElementById('user-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('user-name-input').focus(), 50);
}

function updateUserDisplay() {
  document.getElementById('current-user-name').textContent = userName || '?';
  const badge = document.getElementById('current-user-role');
  badge.textContent = '';
  badge.className = '';
}

// ── SOCKET.IO ─────────────────────────────────────────────
socket.on('connect', () => setConnectionStatus(true));
socket.on('disconnect', () => setConnectionStatus(false));
socket.on('reklamation_neu', r => {
  alleReklamationen.unshift(r);
  renderListe();
  ladeStatistik();
  if (r.erstellt_von !== userName)
    toast(`Neue Reklamation: ${r.reklamationsnummer} (${r.kundenname})`, 'info');
});
socket.on('reklamation_update', r => {
  const idx = alleReklamationen.findIndex(x => x.id === r.id);
  if (idx !== -1) alleReklamationen[idx] = r;
  renderListe();
  ladeStatistik();
  if (detailOpenId === r.id) renderDetail(r);
});
socket.on('reklamation_geloescht', ({ id }) => {
  alleReklamationen = alleReklamationen.filter(r => r.id !== id);
  renderListe();
  ladeStatistik();
  if (detailOpenId === id) closeDetailModal();
});

function setConnectionStatus(connected) {
  const dot   = document.querySelector('.dot');
  const label = document.querySelector('.conn-label');
  dot.classList.toggle('connected', connected);
  label.classList.toggle('connected', connected);
  label.textContent = connected ? 'Verbunden' : 'Getrennt';
}

// ── DATEN LADEN ───────────────────────────────────────────
async function ladeReklamationen() {
  try {
    const res = await fetch('/api/reklamationen');
    if (res.status === 401) { zeigeLoginModal(); return; }
    alleReklamationen = await res.json();
    renderListe();
  } catch {
    toast('Fehler beim Laden', 'error');
  }
}

async function ladeStatistik() {
  try {
    const res = await fetch('/api/statistik');
    const d = await res.json();
    animateNum('stat-neu', d.neu);
    animateNum('stat-bearbeitung', d.in_bearbeitung);
    animateNum('stat-erledigt', d.erledigt);
    animateNum('stat-gesamt', d.gesamt);
  } catch {}
}

// ── NEUE REKLAMATION ──────────────────────────────────────
function openNeuModal() {
  if (!userName) { document.getElementById('user-modal').classList.remove('hidden'); return; }
  document.getElementById('n-auftragsdatum').value = new Date().toISOString().slice(0, 10);
  document.getElementById('neu-modal').classList.remove('hidden');
}

function closeNeuModal() {
  document.getElementById('neu-modal').classList.add('hidden');
  ['n-kundenname','n-auftragsnummer','n-artikelnummer','n-artikelname','n-lieferantenname','n-lieferanten-artikelnummer','n-reklagrund'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('n-menge').value = '1';
  neuBilder = [];
  renderNeuBilderVorschau();
}

async function submitNeuReklamation() {
  const kundenname     = document.getElementById('n-kundenname').value.trim();
  const auftragsnummer = document.getElementById('n-auftragsnummer').value.trim();
  const auftragsdatum  = document.getElementById('n-auftragsdatum').value.trim();
  const artikelname    = document.getElementById('n-artikelname').value.trim();
  const reklagrund     = document.getElementById('n-reklagrund').value.trim();

  if (!kundenname)     { shake(document.getElementById('n-kundenname')); return; }
  if (!auftragsnummer) { shake(document.getElementById('n-auftragsnummer')); return; }
  if (!auftragsdatum)  { shake(document.getElementById('n-auftragsdatum')); return; }
  if (!artikelname)    { shake(document.getElementById('n-artikelname')); return; }
  if (!reklagrund)     { shake(document.getElementById('n-reklagrund')); return; }

  const fd = new FormData();
  fd.append('kundenname', kundenname);
  fd.append('auftragsnummer', auftragsnummer);
  fd.append('auftragsdatum', auftragsdatum);
  fd.append('artikelnummer', document.getElementById('n-artikelnummer').value.trim());
  fd.append('artikelname', artikelname);
  fd.append('menge', document.getElementById('n-menge').value);
  fd.append('lieferantenname', document.getElementById('n-lieferantenname').value.trim());
  fd.append('lieferanten_artikelnummer', document.getElementById('n-lieferanten-artikelnummer').value.trim());
  fd.append('reklagrund', reklagrund);
  fd.append('erstellt_von', userName);
  for (const f of neuBilder) fd.append('bilder', f);

  try {
    const res = await fetch('/api/reklamationen', { method: 'POST', body: fd });
    if (!res.ok) throw new Error();
    closeNeuModal();
    toast('Reklamation angelegt', 'success');
  } catch {
    toast('Fehler beim Anlegen', 'error');
  }
}

// ── NÄCHSTER SCHRITT ──────────────────────────────────────
function getNextStep(r) {
  if (!r.an_lieferant_am)           return { nr: 2, label: 'An Lieferant melden' };
  if (!r.lieferant_entscheidung_am) return { nr: 3, label: 'Entscheidung eintragen' };
  if (!r.lieferant_gutschrift_am)   return { nr: 4, label: 'Gutschriftsnr. eintragen' };
  if (!r.loesung_am)                return { nr: 5, label: 'Kundenlösung eintragen' };
  if (!r.erledigt_am)               return { nr: 6, label: 'Als erledigt markieren' };
  return null;
}

// ── FILTER & LISTE ────────────────────────────────────────
function setFilter(filter, btn) {
  aktuellerFilter = filter;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const sammelToolbar = document.getElementById('sammel-toolbar');
  if (filter === 'sammelreklamation') {
    sammelToolbar.classList.remove('hidden');
    aktualisiereSammelLieferanten();
  } else {
    sammelToolbar.classList.add('hidden');
  }
  renderListe();
}

async function aktualisiereSammelLieferanten() {
  try {
    const res = await fetch('/api/sammelreklamation/lieferanten');
    const liste = await res.json();
    const sel = document.getElementById('sammel-lieferant-select');
    const current = sel.value;
    sel.innerHTML = '<option value="">Alle Lieferanten</option>' +
      liste.map(l => `<option value="${escHtml(l)}" ${l === current ? 'selected' : ''}>${escHtml(l)}</option>`).join('');
  } catch {}
}

function exportSammelreklamation() {
  const lieferant = document.getElementById('sammel-lieferant-select').value;
  const url = '/api/export/sammelreklamation' + (lieferant ? `?lieferant=${encodeURIComponent(lieferant)}` : '');
  const a = document.createElement('a');
  a.href = url;
  a.click();
}

function renderListe() {
  const suchtext = (document.getElementById('search-input')?.value || '').toLowerCase();

  const gefiltert = alleReklamationen.filter(r => {
    const ns = getNextStep(r);
    if (aktuellerFilter === 'aktiv'   && r.status === 'erledigt') return false;
    if (aktuellerFilter === 'archiv'  && r.status !== 'erledigt') return false;
    if (aktuellerFilter === 's2' && ns?.nr !== 2) return false;
    if (aktuellerFilter === 's3' && ns?.nr !== 3) return false;
    if (aktuellerFilter === 's4' && ns?.nr !== 4) return false;
    if (aktuellerFilter === 's5' && ns?.nr !== 5) return false;
    if (aktuellerFilter === 's6' && ns?.nr !== 6) return false;
    if (aktuellerFilter === 'sammelreklamation' && r.schritt2_typ !== 'sammelreklamation') return false;
    if (aktuellerFilter === 'sammelreklamation' && r.status === 'erledigt') return false;
    if (aktuellerFilter === 'sammelreklamation') {
      const lieferantFilter = document.getElementById('sammel-lieferant-select')?.value;
      if (lieferantFilter && r.lieferantenname !== lieferantFilter) return false;
    }
    if (suchtext) {
      const hay = `${r.reklamationsnummer} ${r.kundenname} ${r.artikelname} ${r.artikelnummer}`.toLowerCase();
      if (!hay.includes(suchtext)) return false;
    }
    return true;
  });

  const container = document.getElementById('rekla-liste');
  if (gefiltert.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/>
      </svg>
      <p>${suchtext ? 'Keine Ergebnisse' : 'Keine Einträge'}</p>
    </div>`;
    return;
  }
  container.innerHTML = gefiltert.map(r => renderKarte(r)).join('');
}

const SCHRITTE = [
  { nr: 1, kurz: 'Neu' },
  { nr: 2, kurz: 'Lieferant' },
  { nr: 3, kurz: 'Entscheidung' },
  { nr: 4, kurz: 'Gutschrift' },
  { nr: 5, kurz: 'Lösung' },
  { nr: 6, kurz: 'Erledigt' },
];

function renderSchrittLeiste(r) {
  const done = [
    true,
    !!r.an_lieferant_am,
    !!r.lieferant_entscheidung_am,
    !!r.lieferant_gutschrift_am,
    !!r.loesung_am,
    !!r.erledigt_am,
  ];
  // aktiver Schritt = erster nicht erledigter
  const aktivIdx = done.findIndex(d => !d);
  const aktivNr = aktivIdx === -1 ? 7 : aktivIdx + 1;
  return `<div class="schritt-leiste">${SCHRITTE.map((s, i) => {
    const isDone = done[i];
    const isCurrent = !isDone && s.nr === aktivNr;
    const cls = isDone ? 'sl-done' : isCurrent ? 'sl-active' : 'sl-pending';
    const marker = isDone ? '✓' : s.nr;
    return `<div class="sl-step ${cls}"><span class="sl-nr">${marker}</span><span class="sl-label">${s.kurz}</span></div>`;
  }).join('')}</div>`;
}

function renderKarte(r) {
  const statusInfo = getStatusInfo(r);
  const hinweiseBadge = r.hinweise.length > 0
    ? `<span class="hinweise-badge">💬 ${r.hinweise.length}</span>`
    : '';
  return `
    <div class="rekla-card" onclick="openDetail(${r.id})">
      <div class="rekla-card-top">
        <span class="rekla-nr">${escHtml(r.reklamationsnummer)}</span>
        <div class="rekla-card-badges">
          ${hinweiseBadge}
          <span class="status-badge ${statusInfo.cls}">${statusInfo.label}</span>
        </div>
      </div>
      <div class="rekla-card-body">
        <div class="rekla-kunde"><strong>${escHtml(r.kundenname)}</strong></div>
        <div class="rekla-artikel">${escHtml(r.artikelname)}${r.artikelnummer ? ` <span class="rekla-artnr">(${escHtml(r.artikelnummer)})</span>` : ''} · ${r.menge}×</div>
        <div class="rekla-grund">${escHtml(r.reklagrund)}</div>
      </div>
      ${renderSchrittLeiste(r)}
      <div class="rekla-card-footer">
        <span>${formatDatum(r.erstellt_am)} · ${escHtml(r.erstellt_von)}</span>
      </div>
    </div>`;
}

// ── DETAIL MODAL ──────────────────────────────────────────
function openDetail(id) {
  const r = alleReklamationen.find(r => r.id === id);
  if (!r) return;
  detailOpenId = id;
  document.getElementById('detail-modal').classList.remove('hidden');
  renderDetail(r);
}

function closeDetailModal() {
  detailOpenId = null;
  document.getElementById('detail-modal').classList.add('hidden');
}

function renderDetail(r) {
  const statusInfo = getStatusInfo(r);
  document.getElementById('detail-reklanr').textContent = r.reklamationsnummer;
  const badge = document.getElementById('detail-status-badge');
  badge.textContent = statusInfo.label;
  badge.className = `detail-status-badge ${statusInfo.cls}`;

  // Alle Schritte sind unabhängig bearbeitbar
  const canStep2 = !r.an_lieferant_am;
  const canStep3 = !r.lieferant_entscheidung_am;
  const canStep4 = !r.lieferant_gutschrift_am;
  const canStep5 = !r.loesung_am;
  const canStep6 = !r.erledigt_am;

  document.getElementById('detail-content').innerHTML = `
    <div class="timeline">
      ${schritt1(r)}
      ${schritt2(r, canStep2)}
      ${schritt3(r, canStep3)}
      ${schritt4(r, canStep4)}
      ${schritt5(r, canStep5)}
      ${schritt6(r, canStep6)}
    </div>
    <div class="hinweise-section">
      <h3>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Hinweise
      </h3>
      <div class="hinweise-list">
        ${r.hinweise.length === 0
          ? '<p class="no-hinweise">Noch keine Hinweise.</p>'
          : r.hinweise.map((h, idx) => `
            <div class="hinweis-item" id="hinweis-item-${r.id}-${idx}">
              <div class="hinweis-text">${escHtml(h.text)}</div>
              <div class="hinweis-meta">
                ${escHtml(h.von)} · ${formatDatum(h.am)}
                <button class="hinweis-edit-btn" onclick="editHinweis(${r.id}, ${idx})" title="Bearbeiten">✏</button>
              </div>
            </div>`).join('')}
      </div>
      <div class="hinweis-add">
        <textarea id="hinweis-input" placeholder="Hinweis hinzufügen..." rows="2" maxlength="500"></textarea>
        <button onclick="addHinweis(${r.id})">Hinzufügen</button>
      </div>
    </div>
    <div class="detail-footer">
      <button class="btn-danger-sm" onclick="loescheReklamation(${r.id})">Reklamation löschen</button>
    </div>
  `;
}

function schritt1(r) {
  const bilderHtml = r.bilder.length > 0 ? `
    <div class="bilder-grid">
      ${r.bilder.map(b => `
        <a href="/uploads/${escHtml(b)}" target="_blank">
          <img src="/uploads/${escHtml(b)}" class="bild-thumb" alt="Bild" loading="lazy" />
        </a>`).join('')}
    </div>` : '';
  return `
    <div class="timeline-step done">
      <div class="step-marker done">✓</div>
      <div class="step-body">
        <div class="step-title">Schritt 1 — Anlage</div>
        <div class="step-content">
          <div class="step-grid">
            <div><span class="step-label">Kundenname</span><span>${escHtml(r.kundenname)}</span></div>
            <div><span class="step-label">Auftrag</span><span>${escHtml(r.auftragsnummer)} · ${formatDatum2(r.auftragsdatum)}</span></div>
            <div><span class="step-label">Artikel</span><span>${escHtml(r.artikelname)}${r.artikelnummer ? ` (${escHtml(r.artikelnummer)})` : ''} · ${r.menge}×</span></div>
            ${r.lieferantenname ? `<div><span class="step-label">Lieferant</span><span>${escHtml(r.lieferantenname)}</span></div>` : ''}
            ${r.lieferanten_artikelnummer ? `<div><span class="step-label">Lief.-Artikelnr.</span><span>${escHtml(r.lieferanten_artikelnummer)}</span></div>` : ''}
            <div class="full"><span class="step-label">Reklamationsgrund</span><span>${escHtml(r.reklagrund)}</span></div>
          </div>
          ${bilderHtml}
          <div class="step-footer">Angelegt von <strong>${escHtml(r.erstellt_von)}</strong> · ${formatDatum(r.erstellt_am)}
            <button class="btn-edit-step" onclick="openAktionModal(${r.id}, 1)" title="Ändern">✎</button>
          </div>
        </div>
      </div>
    </div>`;
}

function schritt2(r, canAct) {
  const done = !!r.an_lieferant_am;
  const cls  = done ? 'done' : 'active';
  let body;
  if (done) {
    const typLabel = r.schritt2_typ === 'sammelreklamation'
      ? '<span class="badge-sammel">Sammelreklamation</span>'
      : '<span class="badge-lieferant">An Lieferant gemeldet</span>';
    body = `<div class="step-done-info">${typLabel} · von <strong>${escHtml(r.an_lieferant_von)}</strong> · ${formatDatum(r.an_lieferant_am)}
        <button class="btn-edit-step" onclick="openAktionModal(${r.id}, 2)" title="Ändern">✎</button></div>`;
  } else {
    body = `<button class="btn-action" onclick="openAktionModal(${r.id}, 2)">Weiterverarbeitung festlegen</button>`;
  }
  return `
    <div class="timeline-step ${cls}">
      <div class="step-marker ${cls}">${done ? '✓' : '2'}</div>
      <div class="step-body">
        <div class="step-title">Schritt 2 — An Lieferant / Sammelreklamation</div>
        <div class="step-content">${body}</div>
      </div>
    </div>`;
}

function schritt3(r, canAct) {
  const done = !!r.lieferant_entscheidung_am;
  const cls  = done ? 'done' : canAct ? 'active' : 'pending';
  let body;
  if (done) {
    const badge = r.lieferant_entscheidung === 'anerkannt'
      ? `<span class="badge-anerkannt">✓ Anerkannt</span>`
      : `<span class="badge-abgelehnt">✗ Abgelehnt</span>`;
    body = `<div class="step-done-info">${badge} · Eingetragen von <strong>${escHtml(r.lieferant_entscheidung_von)}</strong> · ${formatDatum(r.lieferant_entscheidung_am)}
      <button class="btn-edit-step" onclick="openAktionModal(${r.id}, 3)" title="Ändern">✎</button></div>`;
  } else if (canAct) {
    body = `<button class="btn-action" onclick="openAktionModal(${r.id}, 3)">Entscheidung des Lieferanten eintragen</button>`;
  } else {
    body = `<p class="step-pending-text">Vorheriger Schritt ausstehend.</p>`;
  }
  return `
    <div class="timeline-step ${cls}">
      <div class="step-marker ${cls}">${done ? '✓' : '3'}</div>
      <div class="step-body">
        <div class="step-title">Schritt 3 — Lieferant: Anerkannt / Abgelehnt</div>
        <div class="step-content">${body}</div>
      </div>
    </div>`;
}

function schritt4(r, canAct) {
  const done = !!r.lieferant_gutschrift_am;
  const cls  = done ? 'done' : canAct ? 'active' : 'pending';
  let body;
  if (done) {
    const gs = r.lieferant_gutschriftsnummer
      ? `Gutschriftsnr.: <strong>${escHtml(r.lieferant_gutschriftsnummer)}</strong> · `
      : (r.lieferant_entscheidung === 'abgelehnt' ? '<span class="badge-auto">Automatisch erledigt</span> · ' : '');
    body = `<div class="step-done-info">${gs}Eingetragen von <strong>${escHtml(r.lieferant_gutschrift_von)}</strong> · ${formatDatum(r.lieferant_gutschrift_am)}
      <button class="btn-edit-step" onclick="openAktionModal(${r.id}, 4)" title="Ändern">✎</button></div>`;
  } else if (canAct) {
    const entscheid = r.lieferant_entscheidung === 'abgelehnt'
      ? `<div class="lieferant-hinweis">⚠ Lieferant hat abgelehnt — Gutschriftsnummer ggf. nicht vorhanden.</div>` : '';
    body = `${entscheid}<button class="btn-action" onclick="openAktionModal(${r.id}, 4)">Gutschriftsnummer Lieferant eintragen</button>`;
  } else {
    body = `<p class="step-pending-text">Vorheriger Schritt ausstehend.</p>`;
  }
  return `
    <div class="timeline-step ${cls}">
      <div class="step-marker ${cls}">${done ? '✓' : '4'}</div>
      <div class="step-body">
        <div class="step-title">Schritt 4 — Gutschriftsnummer Lieferant</div>
        <div class="step-content">${body}</div>
      </div>
    </div>`;
}

function schritt5(r, canAct) {
  const done = !!r.loesung_am;
  const cls  = done ? 'done' : canAct ? 'active' : 'pending';
  let body;
  if (done) {
    let loesungBadge, ref = '';
    if (r.kunden_loesung === 'abgelehnt') {
      loesungBadge = `<span class="badge-abgelehnt">✗ Abgelehnt</span>`;
    } else {
      const lLabel   = r.kunden_loesung === 'gutschrift' ? 'Gutschrift' : 'Ersatz';
      const refLabel = r.kunden_loesung === 'gutschrift' ? 'Gutschriftsnr.' : 'Auftragsnr.';
      loesungBadge = `<span class="badge-loesung">${lLabel}</span>`;
      ref = r.kunden_referenznummer ? `${refLabel}: <strong>${escHtml(r.kunden_referenznummer)}</strong> · ` : '';
    }
    body = `<div class="step-done-info">${loesungBadge} · ${ref}Eingetragen von <strong>${escHtml(r.loesung_von)}</strong> · ${formatDatum(r.loesung_am)}
      <button class="btn-edit-step" onclick="openAktionModal(${r.id}, 5)" title="Ändern">✎</button></div>`;
  } else if (canAct) {
    body = `<button class="btn-action" onclick="openAktionModal(${r.id}, 5)">Kundenlösung eintragen</button>`;
  } else {
    body = `<p class="step-pending-text">Vorheriger Schritt ausstehend.</p>`;
  }
  return `
    <div class="timeline-step ${cls}">
      <div class="step-marker ${cls}">${done ? '✓' : '5'}</div>
      <div class="step-body">
        <div class="step-title">Schritt 5 — Kundenlösung</div>
        <div class="step-content">${body}</div>
      </div>
    </div>`;
}

function schritt6(r, canAct) {
  const done = !!r.erledigt_am;
  const cls  = done ? 'done' : canAct ? 'active' : 'pending';
  const body = done
    ? `<div class="step-done-info">Erledigt von <strong>${escHtml(r.erledigt_von)}</strong> · ${formatDatum(r.erledigt_am)}
        <button class="btn-rueckgaengig" onclick="erledigtRueckgaengig(${r.id})">Rückgängig</button>
       </div>`
    : canAct
      ? `<button class="btn-action btn-erledigt" onclick="openAktionModal(${r.id}, 6)">Als vollständig erledigt markieren</button>`
      : `<p class="step-pending-text">Vorheriger Schritt ausstehend.</p>`;
  return `
    <div class="timeline-step ${cls}">
      <div class="step-marker ${cls}">${done ? '✓' : '6'}</div>
      <div class="step-body">
        <div class="step-title">Schritt 6 — Erledigt</div>
        <div class="step-content">${body}</div>
      </div>
    </div>`;
}

// ── AKTION MODAL ──────────────────────────────────────────
function openAktionModal(id, schritt) {
  aktionReklaId = id;
  aktionSchritt = schritt;
  const r = alleReklamationen.find(r => r.id === id);

  const titel = {
    1: 'Anlage bearbeiten',
    2: r?.schritt2_typ === 'sammelreklamation' ? 'Sammelreklamation' : 'An Lieferant melden',
    3: 'Lieferant-Entscheidung',
    4: 'Gutschriftsnummer Lieferant',
    5: 'Kundenlösung',
    6: 'Reklamation erledigen',
  };
  document.getElementById('aktion-titel').textContent = titel[schritt] || '';

  let inhalt = '';
  if (schritt === 1) {
    inhalt = `
      <div class="aktion-field"><label>Kundenname *</label><input type="text" id="e-kundenname" maxlength="100" value="${escHtml(r?.kundenname || '')}" /></div>
      <div class="aktion-field"><label>Auftragsnummer *</label><input type="text" id="e-auftragsnummer" maxlength="50" value="${escHtml(r?.auftragsnummer || '')}" /></div>
      <div class="aktion-field"><label>Auftragsdatum *</label><input type="date" id="e-auftragsdatum" value="${escHtml(r?.auftragsdatum || '')}" /></div>
      <div class="aktion-field"><label>Artikelnummer</label><input type="text" id="e-artikelnummer" maxlength="50" value="${escHtml(r?.artikelnummer || '')}" /></div>
      <div class="aktion-field"><label>Artikelname *</label><input type="text" id="e-artikelname" maxlength="100" value="${escHtml(r?.artikelname || '')}" /></div>
      <div class="aktion-field"><label>Menge</label><input type="number" id="e-menge" min="1" max="99999" value="${r?.menge || 1}" /></div>
      <div class="aktion-field"><label>Lieferantenname</label><input type="text" id="e-lieferantenname" maxlength="100" value="${escHtml(r?.lieferantenname || '')}" /></div>
      <div class="aktion-field"><label>Lieferanten-Artikelnummer</label><input type="text" id="e-lieferanten-artikelnummer" maxlength="50" value="${escHtml(r?.lieferanten_artikelnummer || '')}" /></div>
      <div class="aktion-field"><label>Reklamationsgrund</label><textarea id="e-reklagrund" rows="3" maxlength="500">${escHtml(r?.reklagrund || '')}</textarea></div>`;
  } else if (schritt === 2) {
    inhalt = `
      <p>Wie soll diese Reklamation weiterverarbeitet werden?</p>
      <div class="radio-group">
        <label class="radio-option">
          <input type="radio" name="schritt2typ" value="an_lieferant" />
          <span>An Lieferant melden</span>
        </label>
        <label class="radio-option">
          <input type="radio" name="schritt2typ" value="sammelreklamation" />
          <span>Für Sammelreklamation speichern</span>
        </label>
      </div>`;
  } else if (schritt === 3) {
    inhalt = `
      <p>Entscheidung des Lieferanten:</p>
      <div class="radio-group">
        <label class="radio-option">
          <input type="radio" name="entscheidung" value="anerkannt" />
          <span class="radio-anerkannt">✓ Anerkannt</span>
        </label>
        <label class="radio-option">
          <input type="radio" name="entscheidung" value="abgelehnt" />
          <span class="radio-abgelehnt">✗ Abgelehnt</span>
        </label>
      </div>`;
  } else if (schritt === 4) {
    const abgelehnt = r?.lieferant_entscheidung === 'abgelehnt';
    inhalt = `
      ${abgelehnt ? '<div class="lieferant-hinweis">⚠ Lieferant hat abgelehnt — Gutschriftsnummer ggf. leer lassen.</div>' : ''}
      <div class="aktion-field">
        <label>Gutschriftsnummer Lieferant (optional)</label>
        <input type="text" id="input-gutschriftsnr" placeholder="z.B. GS-2024-001" maxlength="80" />
      </div>`;
  } else if (schritt === 5) {
    inhalt = `
      <p>Kundenlösung:</p>
      <div class="radio-group">
        <label class="radio-option">
          <input type="radio" name="loesung" value="gutschrift" onchange="toggleLoesungRef()" />
          <span>Gutschrift</span>
        </label>
        <label class="radio-option">
          <input type="radio" name="loesung" value="ersatz" onchange="toggleLoesungRef()" />
          <span>Ersatz</span>
        </label>
        <label class="radio-option">
          <input type="radio" name="loesung" value="abgelehnt" onchange="toggleLoesungRef()" />
          <span class="radio-abgelehnt">✗ Abgelehnt</span>
        </label>
      </div>
      <div class="aktion-field" id="loesung-ref-field">
        <label id="loesung-ref-label">Referenznummer (optional)</label>
        <input type="text" id="input-loesung-ref" placeholder="Nummer eintragen..." maxlength="80" />
      </div>`;
  } else if (schritt === 6) {
    inhalt = `<p>Diese Reklamation als vollständig <strong>erledigt</strong> markieren?</p>`;
  }

  document.getElementById('aktion-inhalt').innerHTML = inhalt;

  // Vorausfüllen bei Bearbeitung bereits erledigter Schritte
  if (schritt === 2) {
    const currentTyp = r?.schritt2_typ || 'an_lieferant';
    const radio = document.querySelector(`input[name="schritt2typ"][value="${currentTyp}"]`);
    if (radio) radio.checked = true;
  }
  if (schritt === 3 && r?.lieferant_entscheidung) {
    const radio = document.querySelector(`input[name="entscheidung"][value="${r.lieferant_entscheidung}"]`);
    if (radio) radio.checked = true;
  }
  if (schritt === 4 && r?.lieferant_gutschriftsnummer) {
    const inp = document.getElementById('input-gutschriftsnr');
    if (inp) inp.value = r.lieferant_gutschriftsnummer;
  }
  if (schritt === 5 && r?.kunden_loesung) {
    const radio = document.querySelector(`input[name="loesung"][value="${r.kunden_loesung}"]`);
    if (radio) { radio.checked = true; toggleLoesungRef(); }
    const inp = document.getElementById('input-loesung-ref');
    if (inp && r.kunden_referenznummer) inp.value = r.kunden_referenznummer;
  }

  document.getElementById('aktion-modal').classList.remove('hidden');
}

function toggleLoesungRef() {
  const loesung = document.querySelector('input[name="loesung"]:checked')?.value;
  const label   = document.getElementById('loesung-ref-label');
  const field   = document.getElementById('loesung-ref-field');
  if (label) label.textContent = loesung === 'gutschrift' ? 'Gutschriftsnummer (optional)' : 'Auftragsnummer (optional)';
  if (field) field.classList.toggle('hidden', loesung === 'abgelehnt');
}

function closeAktionModal() {
  aktionReklaId = null;
  aktionSchritt = null;
  document.getElementById('aktion-modal').classList.add('hidden');
}

async function submitAktion() {
  if (!aktionReklaId || !aktionSchritt) return;
  let url, body;

  if (aktionSchritt === 1) {
    const kundenname     = document.getElementById('e-kundenname')?.value.trim();
    const auftragsnummer = document.getElementById('e-auftragsnummer')?.value.trim();
    const auftragsdatum  = document.getElementById('e-auftragsdatum')?.value.trim();
    const artikelname    = document.getElementById('e-artikelname')?.value.trim();
    if (!kundenname)     { shake(document.getElementById('e-kundenname'));     return; }
    if (!auftragsnummer) { shake(document.getElementById('e-auftragsnummer')); return; }
    if (!auftragsdatum)  { shake(document.getElementById('e-auftragsdatum'));  return; }
    if (!artikelname)    { shake(document.getElementById('e-artikelname'));    return; }
    url  = `/api/reklamationen/${aktionReklaId}/anlage`;
    body = {
      kundenname, auftragsnummer, auftragsdatum, artikelname,
      artikelnummer:           document.getElementById('e-artikelnummer')?.value.trim() || '',
      menge:                   Number(document.getElementById('e-menge')?.value) || 1,
      lieferantenname:         document.getElementById('e-lieferantenname')?.value.trim() || '',
      lieferanten_artikelnummer: document.getElementById('e-lieferanten-artikelnummer')?.value.trim() || '',
      reklagrund:              document.getElementById('e-reklagrund')?.value.trim() || '',
    };
  } else if (aktionSchritt === 2) {
    const typ = document.querySelector('input[name="schritt2typ"]:checked')?.value;
    if (!typ) { toast('Bitte eine Option wählen.', 'error'); return; }
    url  = `/api/reklamationen/${aktionReklaId}/an-lieferant`;
    body = { von: userName, typ };
  } else if (aktionSchritt === 3) {
    const entscheidung = document.querySelector('input[name="entscheidung"]:checked')?.value;
    if (!entscheidung) { toast('Bitte Anerkannt oder Abgelehnt wählen.', 'error'); return; }
    url  = `/api/reklamationen/${aktionReklaId}/lieferant-entscheidung`;
    body = { entscheidung, von: userName };
  } else if (aktionSchritt === 4) {
    const gutschriftsnummer = document.getElementById('input-gutschriftsnr')?.value.trim() || '';
    url  = `/api/reklamationen/${aktionReklaId}/lieferant-gutschrift`;
    body = { gutschriftsnummer, von: userName };
  } else if (aktionSchritt === 5) {
    const loesung = document.querySelector('input[name="loesung"]:checked')?.value;
    if (!loesung) { toast('Bitte Lösung wählen.', 'error'); return; }
    const referenznummer = document.getElementById('input-loesung-ref')?.value.trim() || '';
    url  = `/api/reklamationen/${aktionReklaId}/kundenloesung`;
    body = { loesung, referenznummer, von: userName };
  } else if (aktionSchritt === 6) {
    url  = `/api/reklamationen/${aktionReklaId}/erledigt`;
    body = { von: userName };
  }

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.status);
    }
    closeAktionModal();
    toast('Gespeichert', 'success');
  } catch (e) {
    toast('Fehler: ' + (e.message || 'Unbekannt'), 'error');
  }
}

// ── HINWEISE ──────────────────────────────────────────────
function editHinweis(rekId, idx) {
  const item = document.getElementById(`hinweis-item-${rekId}-${idx}`);
  if (!item) return;
  const textDiv = item.querySelector('.hinweis-text');
  const currentText = textDiv.textContent;
  item.innerHTML = `
    <textarea class="hinweis-edit-textarea" rows="2" maxlength="500">${escHtml(currentText)}</textarea>
    <div class="hinweis-edit-actions">
      <button onclick="saveHinweis(${rekId}, ${idx})">Speichern</button>
      <button class="btn-cancel" onclick="cancelEditHinweis(${rekId}, ${idx}, ${JSON.stringify(currentText)})">Abbrechen</button>
    </div>`;
  item.querySelector('textarea').focus();
}

function cancelEditHinweis(rekId, idx, originalText) {
  const rek = alleReklamationen.find(r => r.id === rekId);
  if (!rek) return;
  renderDetail(rek);
}

async function saveHinweis(rekId, idx) {
  const item = document.getElementById(`hinweis-item-${rekId}-${idx}`);
  if (!item) return;
  const text = item.querySelector('textarea')?.value.trim();
  if (!text) { shake(item.querySelector('textarea')); return; }
  try {
    const res = await fetch(`/api/reklamationen/${rekId}/hinweis/${idx}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error();
    toast('Hinweis aktualisiert', 'success');
  } catch {
    toast('Fehler beim Speichern', 'error');
  }
}

async function erledigtRueckgaengig(id) {
  if (!confirm('Erledigung wirklich rückgängig machen?')) return;
  try {
    const res = await fetch(`/api/reklamationen/${id}/erledigt-rueckgaengig`, { method: 'PATCH' });
    if (!res.ok) throw new Error();
    toast('Erledigung zurückgesetzt', 'success');
  } catch {
    toast('Fehler beim Zurücksetzen', 'error');
  }
}

async function addHinweis(id) {
  const text = document.getElementById('hinweis-input')?.value.trim();
  if (!text) { shake(document.getElementById('hinweis-input')); return; }
  try {
    const res = await fetch(`/api/reklamationen/${id}/hinweis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, von: userName }),
    });
    if (!res.ok) throw new Error();
    toast('Hinweis gespeichert', 'success');
  } catch {
    toast('Fehler beim Speichern', 'error');
  }
}

// ── EXPORT ────────────────────────────────────────────────
function exportCSV() {
  const a = document.createElement('a');
  a.href = '/api/export/csv';
  a.click();
}

// ── LÖSCHEN ───────────────────────────────────────────────
async function loescheReklamation(id) {
  const r = alleReklamationen.find(r => r.id === id);
  if (!confirm(`Reklamation ${r?.reklamationsnummer} wirklich löschen?`)) return;
  try {
    const res = await fetch(`/api/reklamationen/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    toast('Reklamation gelöscht', 'info');
  } catch {
    toast('Fehler beim Löschen', 'error');
  }
}

// ── HILFSFUNKTIONEN ───────────────────────────────────────
function getStatusInfo(r) {
  if (r.status === 'neu')                   return { label: 'Neu',              cls: 'status-neu' };
  if (r.status === 'an_lieferant') {
    if (r.schritt2_typ === 'sammelreklamation') return { label: 'Sammelreklamation', cls: 'status-sammel' };
    return { label: 'An Lieferant', cls: 'status-lieferant' };
  }
  if (r.status === 'lieferant_entscheidung') {
    return r.lieferant_entscheidung === 'anerkannt'
      ? { label: 'Anerkannt',  cls: 'status-anerkannt' }
      : { label: 'Abgelehnt',  cls: 'status-abgelehnt' };
  }
  if (r.status === 'lieferant_gutschrift') {
    return r.lieferant_entscheidung === 'anerkannt'
      ? { label: 'Anerkannt',  cls: 'status-anerkannt' }
      : { label: 'Abgelehnt',  cls: 'status-abgelehnt' };
  }
  if (r.status === 'kundenloesung') return { label: 'Kundenlösung',  cls: 'status-kundenloesung' };
  if (r.status === 'erledigt')      return { label: 'Erledigt',       cls: 'status-erledigt' };
  return { label: r.status, cls: '' };
}

function formatDatum(iso) {
  if (!iso) return '';
  const d       = new Date(iso);
  const heute   = new Date();
  const gestern = new Date(heute); gestern.setDate(heute.getDate() - 1);
  let prefix;
  if (d.toDateString() === heute.toDateString())        prefix = 'Heute';
  else if (d.toDateString() === gestern.toDateString()) prefix = 'Gestern';
  else prefix = d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' });
  return `${prefix} ${d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })}`;
}

function formatDatum2(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}`;
  return dateStr;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shake(el) {
  if (!el) return;
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake .3s ease';
  el.focus();
  setTimeout(() => el.style.animation = '', 400);
}

function animateNum(id, ziel) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  if (start === ziel) return;
  const steps = 12; let i = 0;
  const iv = setInterval(() => {
    i++;
    el.textContent = Math.round(start + (ziel - start) * (i / steps));
    if (i >= steps) clearInterval(iv);
  }, 20);
}

function toast(msg, type = 'info') {
  const icons = {
    success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    info:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icons[type] || icons.info}<span>${escHtml(msg)}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(10px)';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

const shakeStyle = document.createElement('style');
shakeStyle.textContent = `@keyframes shake {
  0%,100%{transform:translateX(0)} 25%{transform:translateX(-6px)} 75%{transform:translateX(6px)}
}`;
document.head.appendChild(shakeStyle);
