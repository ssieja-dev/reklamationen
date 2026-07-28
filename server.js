'use strict';

process.on('uncaughtException', err => {
  console.error('\n  FEHLER:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`  Port ${err.port} ist bereits belegt.\n`);
  }
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
});

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const multer     = require('multer');
const nodemailer = require('nodemailer');

// ── SMTP ──────────────────────────────────────────────────
const SMTP_HOST   = process.env.SMTP_HOST   || '';
const SMTP_PORT   = parseInt(process.env.SMTP_PORT   || '465');
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || SMTP_PORT === 465;
const SMTP_USER   = process.env.SMTP_USER   || '';
const SMTP_PASS   = process.env.SMTP_PASS   || '';
const MAIL_TO     = 'service@pitupita.de';

const transporter = SMTP_USER ? nodemailer.createTransport({
  host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 15000,
}) : null;

async function sendeErinnerungsMail(r, erinnerungDatum) {
  if (!transporter) return;
  const datFmt = d => d ? new Date(d).toLocaleDateString('de-DE') : '–';
  const text = `Erinnerung Hersteller-Reklamation ${r.nummer}

Lieferant:          ${r.lieferant}${r.ansprechpartner ? '\nRechnungsnr.:       ' + r.ansprechpartner : ''}
Artikel:            ${r.artikelname}${r.artikelnummer ? ' (' + r.artikelnummer + ')' : ''}
Menge:              ${r.menge} ${r.einheit}${r.chargennummer ? '\nCharge:             ' + r.chargennummer : ''}
Beanstandung:       ${r.beanstandung}
${r.datum_befund ? 'Datum Befund:       ' + datFmt(r.datum_befund) + '\n' : ''}${r.datum_meldung ? 'Datum Meldung:      ' + datFmt(r.datum_meldung) + '\n' : ''}
Erinnerungsdatum:   ${datFmt(erinnerungDatum)}
Erstellt von:       ${r.erstellt_von} am ${datFmt(r.erstellt_am)}
`;
  try {
    await transporter.sendMail({
      from: `"PITUPITA Reklamationen" <${SMTP_USER}>`,
      to: MAIL_TO,
      subject: `Erinnerung HR ${r.nummer} – ${r.lieferant}`,
      text,
    });
    console.log(`[Erinnerung] Mail gesendet für ${r.nummer} (${erinnerungDatum})`);
  } catch (e) {
    console.error('[Erinnerung] Mail-Fehler:', e.message);
  }
}

const PORTAL_PORT = parseInt(process.env.PORTAL_PORT || '4003');

function validierePortalToken(token) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORTAL_PORT}/api/app-token/${token}`, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(JSON.parse(data));
        else reject(new Error('Ungültig'));
      });
    }).on('error', reject);
  });
}

const app    = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io     = new Server(server);

const DB_FILE     = path.join(__dirname, 'reklamationen.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// ── Passwort-Hashing (scrypt, kein Klartext mehr) ───────────
function pruefePasswort(klartext, gespeichert) {
  if (!gespeichert || !gespeichert.startsWith('scrypt$')) return false;
  const [, salt, hash] = gespeichert.split('$');
  const versuch = crypto.scryptSync(klartext || '', salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(versuch, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Rate-Limiting für Login (Schutz vor Brute-Force) ────────
const loginVersuche = new Map();
function rateLimitLogin(req, res, next) {
  const eintrag = loginVersuche.get(req.ip);
  if (eintrag?.gesperrtBis && Date.now() < eintrag.gesperrtBis) {
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.' });
  }
  next();
}
function meldeLoginSperre(req) {
  try {
    const body = JSON.stringify({ app: 'reklamationen', ip: req.ip, name: 'PIN-Login' });
    const r = http.request({ hostname: 'localhost', port: PORTAL_PORT, path: '/api/security/alert', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, () => {});
    r.on('error', () => {});
    r.write(body);
    r.end();
  } catch {}
}
function loginFehlgeschlagen(req) {
  const eintrag = loginVersuche.get(req.ip) || { anzahl: 0, gesperrtBis: 0 };
  eintrag.anzahl++;
  if (eintrag.anzahl >= 5) {
    eintrag.gesperrtBis = Date.now() + 15 * 60 * 1000;
    eintrag.anzahl = 0;
    meldeLoginSperre(req);
  }
  loginVersuche.set(req.ip, eintrag);
}
function loginErfolgreich(req) { loginVersuche.delete(req.ip); }

function ladeConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return { passwort: 'scrypt$ad0fc085e6ac61651e78d00cc13556b0$1bafa2c554640fbadbde74e3b4587879ffd0f35cd926e555eb09ec65407aa46da87e81421713d8269c4ff91efa7fd7347862e017a6e92f7d59b1636c3af1b337' };
}

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// ── Datenbank ─────────────────────────────────────────────
function ladeDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {}
  return { reklamationen: [], nextId: 1 };
}
function speichereDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}
let db = ladeDB();

// ── Hersteller-Reklamationen initialisieren ───────────────
if (!db.herstellerReklamationen) db.herstellerReklamationen = [];
if (!db.herstellerNextId) db.herstellerNextId = 1;

// Migration: erinnerung_datum → erinnerungen[]
for (const r of db.herstellerReklamationen) {
  if (!Array.isArray(r.erinnerungen)) {
    r.erinnerungen = r.erinnerung_datum
      ? [{ datum: r.erinnerung_datum, gesendet_am: null }]
      : [];
  }
  if (r.datum_befund === undefined)  r.datum_befund  = null;
  if (r.datum_meldung === undefined) r.datum_meldung = null;
}
speichereDB(db);

// ── Migration: alter Status 'rueckmeldung' → neue Felder ──
let migrated = false;
for (const r of db.reklamationen) {
  if (r.status === 'rueckmeldung') {
    r.status = 'lieferant_gutschrift';
    if (!r.lieferant_entscheidung_am) {
      r.lieferant_entscheidung_von = r.rueckmeldung_von || null;
      r.lieferant_entscheidung_am  = r.rueckmeldung_am  || null;
    }
    if (!r.lieferant_gutschrift_am) {
      r.lieferant_gutschrift_von = r.rueckmeldung_von || null;
      r.lieferant_gutschrift_am  = r.rueckmeldung_am  || null;
    }
    migrated = true;
  }
  // Neue Felder ergänzen falls fehlend
  if (r.lieferant_entscheidung_am === undefined) r.lieferant_entscheidung_am = null;
  if (r.lieferant_entscheidung_von === undefined) r.lieferant_entscheidung_von = null;
  if (r.lieferant_gutschrift_am === undefined) r.lieferant_gutschrift_am = null;
  if (r.lieferant_gutschrift_von === undefined) r.lieferant_gutschrift_von = null;
  if (r.lieferantenname === undefined) r.lieferantenname = '';
  if (r.lieferanten_artikelnummer === undefined) r.lieferanten_artikelnummer = '';
  if (r.schritt2_typ === undefined) r.schritt2_typ = r.an_lieferant_am ? 'an_lieferant' : null;
}
if (migrated) speichereDB(db);

// ── Multer ────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilder erlaubt'));
  }
});

// ── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(session({
  name: 'rekla.sid',
  secret: 'rekla-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

// Portal-Token abfangen
app.get('/', async (req, res, next) => {
  const token = req.query.portal_token;
  if (!token) {
    if (!req.session?.angemeldet) return res.redirect((req.hostname === 'portal.pitupita.eu' ? `https://${req.hostname}/` : `http://${req.hostname}:${PORTAL_PORT}/`));
    return next();
  }
  try {
    const user = await validierePortalToken(token);
    req.session.angemeldet = true;
    req.session.userName = user.name;
    res.redirect('/');
  } catch {
    res.redirect('/');
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Login ─────────────────────────────────────────────────
app.post('/api/login', rateLimitLogin, (req, res) => {
  const { passwort } = req.body;
  const config = ladeConfig();
  if (pruefePasswort(passwort, config.passwort)) {
    loginErfolgreich(req);
    req.session.angemeldet = true;
    res.json({ ok: true });
  } else {
    loginFehlgeschlagen(req);
    res.status(401).json({ error: 'Falsches Passwort' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (req.session?.angemeldet && req.session?.userName)
    res.json({ name: req.session.userName });
  else
    res.status(401).json({ error: 'Nicht angemeldet' });
});

// ── Auth-Middleware für alle API-Routen ───────────────────
app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();
  if (req.session?.angemeldet) return next();
  res.status(401).json({ error: 'Nicht angemeldet' });
});

// ── Hilfsfunktionen ───────────────────────────────────────
const STATUS_ORDER = ['neu','an_lieferant','lieferant_entscheidung','lieferant_gutschrift','kundenloesung','erledigt'];
function statusIdx(s) { return STATUS_ORDER.indexOf(s); }

function buildReklanummer(auftragsnummer, auftragsdatum) {
  const teile = auftragsdatum.split('-');
  const datumFormatiert = teile.length === 3
    ? `${teile[2]}${teile[1]}${teile[0]}`
    : auftragsdatum.replace(/\D/g, '');
  return `DS1-${auftragsnummer.trim()}-${datumFormatiert}`;
}

// ── API ───────────────────────────────────────────────────
app.get('/api/config', (req, res) => res.json({ portalPort: PORTAL_PORT }));

app.get('/api/reklamationen', (req, res) => {
  const sorted = [...db.reklamationen].sort((a, b) =>
    new Date(b.erstellt_am) - new Date(a.erstellt_am)
  );
  res.json(sorted);
});

app.post('/api/reklamationen', upload.array('bilder', 10), (req, res) => {
  const { kundenname, auftragsnummer, auftragsdatum, artikelnummer,
          artikelname, menge, reklagrund, erstellt_von,
          lieferantenname, lieferanten_artikelnummer } = req.body;
  if (!kundenname?.trim() || !auftragsnummer?.trim() || !auftragsdatum?.trim() ||
      !artikelname?.trim() || !erstellt_von?.trim()) {
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  }
  const reklamation = {
    id: db.nextId++,
    reklamationsnummer: buildReklanummer(auftragsnummer, auftragsdatum),
    status: 'neu',
    kundenname: kundenname.trim(),
    auftragsnummer: auftragsnummer.trim(),
    auftragsdatum: auftragsdatum.trim(),
    artikelnummer: (artikelnummer || '').trim(),
    artikelname: artikelname.trim(),
    menge: Number(menge) || 1,
    lieferantenname: (lieferantenname || '').trim(),
    lieferanten_artikelnummer: (lieferanten_artikelnummer || '').trim(),
    reklagrund: (reklagrund || '').trim(),
    bilder: (req.files || []).map(f => f.filename),
    erstellt_von: erstellt_von.trim(),
    erstellt_am: new Date().toISOString(),
    // Schritt 2
    schritt2_typ: null,
    an_lieferant_von: null, an_lieferant_am: null,
    // Schritt 3
    lieferant_entscheidung: null,
    lieferant_entscheidung_von: null, lieferant_entscheidung_am: null,
    // Schritt 4
    lieferant_gutschriftsnummer: null,
    lieferant_gutschrift_von: null, lieferant_gutschrift_am: null,
    // Schritt 5
    kunden_loesung: null, kunden_referenznummer: null,
    loesung_von: null, loesung_am: null,
    // Schritt 6
    erledigt_von: null, erledigt_am: null,
    hinweise: []
  };
  db.reklamationen.push(reklamation);
  speichereDB(db);
  io.emit('reklamation_neu', reklamation);
  res.json(reklamation);
});

// Schritt 1: Anlage bearbeiten
app.patch('/api/reklamationen/:id/anlage', (req, res) => {
  const r = db.reklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { kundenname, auftragsnummer, auftragsdatum, artikelnummer, artikelname, menge, reklagrund,
          lieferantenname, lieferanten_artikelnummer } = req.body;
  if (!kundenname?.trim() || !auftragsnummer?.trim() || !auftragsdatum?.trim() || !artikelname?.trim())
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  r.kundenname                = kundenname.trim();
  r.auftragsnummer            = auftragsnummer.trim();
  r.auftragsdatum             = auftragsdatum.trim();
  r.artikelnummer             = (artikelnummer || '').trim();
  r.artikelname               = artikelname.trim();
  r.menge                     = Number(menge) || 1;
  r.lieferantenname           = (lieferantenname || '').trim();
  r.lieferanten_artikelnummer = (lieferanten_artikelnummer || '').trim();
  r.reklagrund                = (reklagrund || '').trim();
  r.reklamationsnummer = buildReklanummer(r.auftragsnummer, r.auftragsdatum);
  speichereDB(db);
  io.emit('reklamation_update', r);
  res.json(r);
});

// Schritt 2: An Lieferant gemeldet / Sammelreklamation
app.patch('/api/reklamationen/:id/an-lieferant', (req, res) => {
  const r = db.reklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { von, typ } = req.body;
  console.log('[an-lieferant] id=%s von=%j typ=%j', req.params.id, von, typ);
  if (!von?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  if (!['an_lieferant', 'sammelreklamation'].includes(typ))
    return res.status(400).json({ error: 'Ungültiger Typ' });
  if (statusIdx(r.status) < statusIdx('an_lieferant')) r.status = 'an_lieferant';
  r.schritt2_typ     = typ;
  r.an_lieferant_von = von.trim();
  r.an_lieferant_am  = new Date().toISOString();
  speichereDB(db);
  io.emit('reklamation_update', r);
  res.json(r);
});

// Schritt 3: Lieferant-Entscheidung (anerkannt / abgelehnt)
app.patch('/api/reklamationen/:id/lieferant-entscheidung', (req, res) => {
  const r = db.reklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { entscheidung, von } = req.body;
  if (!['anerkannt', 'abgelehnt'].includes(entscheidung))
    return res.status(400).json({ error: 'Ungültige Entscheidung' });
  if (!von?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  if (statusIdx(r.status) < statusIdx('lieferant_entscheidung')) r.status = 'lieferant_entscheidung';
  r.lieferant_entscheidung = entscheidung;
  r.lieferant_entscheidung_von = von.trim();
  r.lieferant_entscheidung_am  = new Date().toISOString();
  // Schritt 4 automatisch erledigen wenn Lieferant abgelehnt hat
  if (entscheidung === 'abgelehnt' && !r.lieferant_gutschrift_am) {
    if (statusIdx(r.status) < statusIdx('lieferant_gutschrift')) r.status = 'lieferant_gutschrift';
    r.lieferant_gutschriftsnummer = '';
    r.lieferant_gutschrift_von = von.trim();
    r.lieferant_gutschrift_am  = new Date().toISOString();
  }
  speichereDB(db);
  io.emit('reklamation_update', r);
  res.json(r);
});

// Schritt 4: Gutschriftsnummer Lieferant
app.patch('/api/reklamationen/:id/lieferant-gutschrift', (req, res) => {
  const r = db.reklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { gutschriftsnummer, von } = req.body;
  if (!von?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  if (statusIdx(r.status) < statusIdx('lieferant_gutschrift')) r.status = 'lieferant_gutschrift';
  r.lieferant_gutschriftsnummer = (gutschriftsnummer || '').trim();
  r.lieferant_gutschrift_von = von.trim();
  r.lieferant_gutschrift_am  = new Date().toISOString();
  speichereDB(db);
  io.emit('reklamation_update', r);
  res.json(r);
});

// Schritt 5: Kundenlösung
app.patch('/api/reklamationen/:id/kundenloesung', (req, res) => {
  const r = db.reklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { loesung, referenznummer, von } = req.body;
  if (!['gutschrift', 'ersatz', 'abgelehnt'].includes(loesung))
    return res.status(400).json({ error: 'Ungültige Lösung' });
  if (!von?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  if (statusIdx(r.status) < statusIdx('kundenloesung')) r.status = 'kundenloesung';
  r.kunden_loesung = loesung;
  r.kunden_referenznummer = (referenznummer || '').trim();
  r.loesung_von = von.trim();
  r.loesung_am  = new Date().toISOString();
  speichereDB(db);
  io.emit('reklamation_update', r);
  res.json(r);
});

// Schritt 6: Erledigt
app.patch('/api/reklamationen/:id/erledigt', (req, res) => {
  const r = db.reklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { von } = req.body;
  if (!von?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  if (statusIdx(r.status) < statusIdx('erledigt')) r.status = 'erledigt';
  r.erledigt_von = von.trim();
  r.erledigt_am  = new Date().toISOString();
  speichereDB(db);
  io.emit('reklamation_update', r);
  res.json(r);
});

// Hinweis
app.post('/api/reklamationen/:id/hinweis', (req, res) => {
  const r = db.reklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { text, von } = req.body;
  if (!text?.trim() || !von?.trim())
    return res.status(400).json({ error: 'Text und Name erforderlich' });
  r.hinweise.push({ text: text.trim(), von: von.trim(), am: new Date().toISOString() });
  speichereDB(db);
  io.emit('reklamation_update', r);
  res.json(r);
});

// Erledigt rückgängig
app.patch('/api/reklamationen/:id/erledigt-rueckgaengig', (req, res) => {
  const r = db.reklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  if (r.status !== 'erledigt') return res.status(400).json({ error: 'Nicht erledigt' });
  r.status      = 'kundenloesung';
  r.erledigt_von = null;
  r.erledigt_am  = null;
  speichereDB(db);
  io.emit('reklamation_update', r);
  res.json(r);
});

// Hinweis bearbeiten
app.patch('/api/reklamationen/:id/hinweis/:idx', (req, res) => {
  const r = db.reklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const idx = parseInt(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= r.hinweise.length)
    return res.status(400).json({ error: 'Ungültiger Index' });
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text erforderlich' });
  r.hinweise[idx].text = text.trim();
  speichereDB(db);
  io.emit('reklamation_update', r);
  res.json(r);
});

// Löschen
app.delete('/api/reklamationen/:id', (req, res) => {
  const idx = db.reklamationen.findIndex(r => r.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Nicht gefunden' });
  db.reklamationen.splice(idx, 1);
  speichereDB(db);
  io.emit('reklamation_geloescht', { id: parseInt(req.params.id) });
  res.json({ ok: true });
});

// CSV Export
app.get('/api/export/csv', (req, res) => {
  const cols = [
    'Reklamationsnummer','Status','Kundenname','Auftragsnummer','Auftragsdatum',
    'Artikelnummer','Artikelname','Menge','Lieferantenname','Lief.-Artikelnummer','Reklamationsgrund',
    'Erstellt von','Erstellt am',
    'An Lieferant von','An Lieferant am',
    'Lieferant Entscheidung','Entscheidung von','Entscheidung am',
    'Gutschriftsnr. Lieferant','Gutschrift von','Gutschrift am',
    'Kundenlösung','Referenznummer','Lösung von','Lösung am',
    'Erledigt von','Erledigt am'
  ];

  const fmt = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const rows = db.reklamationen.map(r => [
    r.reklamationsnummer, r.status, r.kundenname, r.auftragsnummer, r.auftragsdatum,
    r.artikelnummer, r.artikelname, r.menge, r.lieferantenname, r.lieferanten_artikelnummer, r.reklagrund,
    r.erstellt_von, fmt(r.erstellt_am),
    r.an_lieferant_von, fmt(r.an_lieferant_am),
    r.lieferant_entscheidung, r.lieferant_entscheidung_von, fmt(r.lieferant_entscheidung_am),
    r.lieferant_gutschriftsnummer, r.lieferant_gutschrift_von, fmt(r.lieferant_gutschrift_am),
    r.kunden_loesung, r.kunden_referenznummer, r.loesung_von, fmt(r.loesung_am),
    r.erledigt_von, fmt(r.erledigt_am)
  ].map(esc).join(';'));

  const csv = '\uFEFF' + cols.map(esc).join(';') + '\r\n' + rows.join('\r\n');
  const datum = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Reklamationen_${datum}.csv"`);
  res.send(csv);
});

// Sammelreklamation Export
app.get('/api/export/sammelreklamation', (req, res) => {
  const lieferant = (req.query.lieferant || '').trim();
  let liste = db.reklamationen.filter(r => r.schritt2_typ === 'sammelreklamation' && r.status !== 'erledigt');
  if (lieferant) {
    liste = liste.filter(r => (r.lieferantenname || '').toLowerCase() === lieferant.toLowerCase());
  }
  const cols = ['Reklamationsnummer', 'Lieferanten-Artikelnummer', 'Menge', 'Reklamationsgrund'];
  const esc  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = liste.map(r => [
    r.reklamationsnummer,
    r.lieferanten_artikelnummer || '',
    r.menge,
    r.reklagrund
  ].map(esc).join(';'));
  const csv  = '\uFEFF' + cols.map(esc).join(';') + '\r\n' + rows.join('\r\n');
  const datum = new Date().toISOString().slice(0, 10);
  const safeName = lieferant ? lieferant.replace(/[^a-zA-Z0-9_\-äöüÄÖÜß ]/g, '_') : 'alle';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Sammelreklamation_${safeName}_${datum}.csv"`);
  res.send(csv);
});

// Hersteller-Reklamationen Export
app.get('/api/export/hersteller-csv', (req, res) => {
  const cols = [
    'Nummer','Status','Lieferant','Rechnungsnummer Lieferant','Artikelnummer','Artikelname',
    'Menge','Einheit','Chargennummer','Beanstandung',
    'Datum Befund','Datum Meldung',
    'Gesendet von','Gesendet am','Gesendet Art',
    'Rückmeldung','Rückmeldung von','Rückmeldung am',
    'Entscheidung','Gutschriftsnummer','Gutschriftsbetrag',
    'Erstellt von','Erstellt am',
    'Erledigt von','Erledigt am'
  ];

  const fmt = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };
  const fmtDatum = d => d ? new Date(d).toLocaleDateString('de-DE') : '';
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const rows = db.herstellerReklamationen.map(r => [
    r.nummer, r.status, r.lieferant, r.ansprechpartner, r.artikelnummer, r.artikelname,
    r.menge, r.einheit, r.chargennummer, r.beanstandung,
    fmtDatum(r.datum_befund), fmtDatum(r.datum_meldung),
    r.gesendet_von, fmt(r.gesendet_am), r.gesendet_art,
    r.rueckmeldung_text, r.rueckmeldung_von, fmt(r.rueckmeldung_am),
    r.entscheidung, r.gutschriftsnummer, r.gutschriftsbetrag,
    r.erstellt_von, fmt(r.erstellt_am),
    r.erledigt_von, fmt(r.erledigt_am)
  ].map(esc).join(';'));

  const csv = '﻿' + cols.map(esc).join(';') + '\r\n' + rows.join('\r\n');
  const datum = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Hersteller-Reklamationen_${datum}.csv"`);
  res.send(csv);
});

// Lieferanten-Liste für Sammelreklamation
app.get('/api/sammelreklamation/lieferanten', (req, res) => {
  const liste = db.reklamationen
    .filter(r => r.schritt2_typ === 'sammelreklamation' && r.status !== 'erledigt' && r.lieferantenname)
    .map(r => r.lieferantenname);
  res.json([...new Set(liste)].sort());
});

// Statistik
app.get('/api/statistik', (req, res) => {
  const gesamt = db.reklamationen.length;
  const neu    = db.reklamationen.filter(r => r.status === 'neu').length;
  const in_bearbeitung = db.reklamationen.filter(r =>
    ['an_lieferant','lieferant_entscheidung','lieferant_gutschrift','kundenloesung'].includes(r.status)
  ).length;
  const erledigt = db.reklamationen.filter(r => r.status === 'erledigt').length;
  res.json({ gesamt, neu, in_bearbeitung, erledigt });
});

// ── Hersteller-Reklamationen API ──────────────────────────

function buildHerstellerNummer(id) {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  return `HR-${y}${m}-${String(id).padStart(3, '0')}`;
}

app.get('/api/hersteller', (req, res) => {
  const sorted = [...db.herstellerReklamationen].sort((a, b) =>
    new Date(b.erstellt_am) - new Date(a.erstellt_am)
  );
  res.json(sorted);
});

app.post('/api/hersteller', upload.array('bilder', 10), (req, res) => {
  const { lieferant, ansprechpartner, artikelnummer, artikelname,
          menge, einheit, chargennummer, beanstandung, erstellt_von,
          datum_befund, datum_meldung, erinnerungen } = req.body;
  if (!lieferant?.trim() || !artikelname?.trim() || !beanstandung?.trim() || !erstellt_von?.trim())
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  let erinnerungenArr = [];
  try { erinnerungenArr = JSON.parse(erinnerungen || '[]'); } catch {}
  const r = {
    id: db.herstellerNextId++,
    nummer: buildHerstellerNummer(db.herstellerNextId - 1),
    status: 'offen',
    lieferant: lieferant.trim(),
    ansprechpartner: (ansprechpartner || '').trim(),
    artikelnummer: (artikelnummer || '').trim(),
    artikelname: artikelname.trim(),
    menge: Number(menge) || 1,
    einheit: (einheit || 'Stk.').trim(),
    chargennummer: (chargennummer || '').trim(),
    beanstandung: beanstandung.trim(),
    datum_befund: datum_befund || null,
    datum_meldung: datum_meldung || null,
    erinnerungen: erinnerungenArr.map(d => ({ datum: d, gesendet_am: null })),
    erinnerung_datum: erinnerungenArr[0] || null,
    bilder: (req.files || []).map(f => f.filename),
    gesendet_am: null, gesendet_von: null, gesendet_art: null,
    rueckmeldung_text: null, rueckmeldung_am: null, rueckmeldung_von: null,
    entscheidung: null,
    gutschriftsnummer: null, gutschriftsbetrag: null,
    erledigt_von: null, erledigt_am: null,
    erstellt_von: erstellt_von.trim(),
    erstellt_am: new Date().toISOString(),
    hinweise: []
  };
  db.herstellerReklamationen.push(r);
  speichereDB(db);
  io.emit('hersteller_neu', r);
  res.json(r);
});

app.patch('/api/hersteller/:id/bearbeiten', upload.array('bilder', 10), (req, res) => {
  const r = db.herstellerReklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { lieferant, ansprechpartner, artikelnummer, artikelname, menge, einheit,
          chargennummer, beanstandung, datum_befund, datum_meldung, erinnerungen, bilder_loeschen } = req.body;
  if (!lieferant?.trim() || !artikelname?.trim() || !beanstandung?.trim())
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  let erinnerungenArr = [];
  try { erinnerungenArr = JSON.parse(erinnerungen || '[]'); } catch {}
  r.lieferant       = lieferant.trim();
  r.ansprechpartner = (ansprechpartner || '').trim();
  r.artikelnummer   = (artikelnummer || '').trim();
  r.artikelname     = artikelname.trim();
  r.menge           = Number(menge) || 1;
  r.einheit         = (einheit || 'Stk.').trim();
  r.chargennummer   = (chargennummer || '').trim();
  r.beanstandung    = beanstandung.trim();
  r.datum_befund    = datum_befund || null;
  r.datum_meldung   = datum_meldung || null;
  // Erinnerungen mergen: bestehende gesendet_am-Einträge erhalten
  const alteMap = {};
  (r.erinnerungen || []).forEach(e => { alteMap[e.datum] = e.gesendet_am; });
  r.erinnerungen = erinnerungenArr.map(d => ({ datum: d, gesendet_am: alteMap[d] || null }));
  r.erinnerung_datum = erinnerungenArr[0] || null;
  // Bilder löschen
  const loeschen = JSON.parse(bilder_loeschen || '[]');
  if (!r.bilder) r.bilder = [];
  for (const filename of loeschen) {
    r.bilder = r.bilder.filter(b => b !== filename);
    try { fs.unlinkSync(path.join(UPLOADS_DIR, filename)); } catch {}
  }
  // Neue Bilder anhängen
  for (const f of (req.files || [])) r.bilder.push(f.filename);
  speichereDB(db);
  io.emit('hersteller_update', r);
  res.json(r);
});

app.patch('/api/hersteller/:id/senden', (req, res) => {
  const r = db.herstellerReklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { von, art, erinnerung_datum } = req.body;
  if (!von?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  r.status       = 'gesendet';
  r.gesendet_von = von.trim();
  r.gesendet_art = (art || 'sonstig').trim();
  r.gesendet_am  = new Date().toISOString();
  speichereDB(db);
  io.emit('hersteller_update', r);
  res.json(r);
});

app.patch('/api/hersteller/:id/rueckmeldung', (req, res) => {
  const r = db.herstellerReklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { von, rueckmeldung_text, entscheidung, gutschriftsnummer, gutschriftsbetrag } = req.body;
  if (!von?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  if (!['anerkannt','abgelehnt','teilweise'].includes(entscheidung))
    return res.status(400).json({ error: 'Ungültige Entscheidung' });
  if (r.status === 'erledigt')
    return res.status(400).json({ error: 'Reklamation ist bereits erledigt' });
  r.status              = 'rueckmeldung';
  r.rueckmeldung_von    = von.trim();
  r.rueckmeldung_text   = (rueckmeldung_text || '').trim();
  r.rueckmeldung_am     = new Date().toISOString();
  r.entscheidung        = entscheidung;
  r.gutschriftsnummer   = (gutschriftsnummer || '').trim();
  r.gutschriftsbetrag   = (gutschriftsbetrag || '').trim();
  r.erinnerungen        = [];
  r.erinnerung_datum    = null;
  speichereDB(db);
  io.emit('hersteller_update', r);
  res.json(r);
});

app.patch('/api/hersteller/:id/erledigt', (req, res) => {
  const r = db.herstellerReklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { von } = req.body;
  if (!von?.trim()) return res.status(400).json({ error: 'Name erforderlich' });
  r.status           = 'erledigt';
  r.erledigt_von     = von.trim();
  r.erledigt_am      = new Date().toISOString();
  r.erinnerungen     = [];
  r.erinnerung_datum = null;
  speichereDB(db);
  io.emit('hersteller_update', r);
  res.json(r);
});

app.patch('/api/hersteller/:id/erledigt-rueckgaengig', (req, res) => {
  const r = db.herstellerReklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  if (r.status !== 'erledigt') return res.status(400).json({ error: 'Nicht erledigt' });
  r.status      = r.rueckmeldung_am ? 'rueckmeldung' : (r.gesendet_am ? 'gesendet' : 'offen');
  r.erledigt_von = null;
  r.erledigt_am  = null;
  speichereDB(db);
  io.emit('hersteller_update', r);
  res.json(r);
});

app.patch('/api/hersteller/:id/erinnerung', (req, res) => {
  const r = db.herstellerReklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  // Erwartet: { erinnerungen: ["2026-07-10", "2026-07-20", ...] }
  const liste = Array.isArray(req.body.erinnerungen) ? req.body.erinnerungen : [];
  const alteMap = {};
  (r.erinnerungen || []).forEach(e => { alteMap[e.datum] = e.gesendet_am; });
  r.erinnerungen     = liste.map(d => ({ datum: d, gesendet_am: alteMap[d] || null }));
  r.erinnerung_datum = liste[0] || null;
  speichereDB(db);
  io.emit('hersteller_update', r);
  res.json(r);
});

app.post('/api/hersteller/:id/hinweis', (req, res) => {
  const r = db.herstellerReklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const { text, von } = req.body;
  if (!text?.trim() || !von?.trim()) return res.status(400).json({ error: 'Text und Name erforderlich' });
  r.hinweise.push({ text: text.trim(), von: von.trim(), am: new Date().toISOString() });
  speichereDB(db);
  io.emit('hersteller_update', r);
  res.json(r);
});

app.patch('/api/hersteller/:id/hinweis/:idx', (req, res) => {
  const r = db.herstellerReklamationen.find(r => r.id === parseInt(req.params.id));
  if (!r) return res.status(404).json({ error: 'Nicht gefunden' });
  const idx = parseInt(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= r.hinweise.length) return res.status(400).json({ error: 'Ungültiger Index' });
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Text erforderlich' });
  r.hinweise[idx].text = text.trim();
  speichereDB(db);
  io.emit('hersteller_update', r);
  res.json(r);
});

app.delete('/api/hersteller/:id', (req, res) => {
  const idx = db.herstellerReklamationen.findIndex(r => r.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Nicht gefunden' });
  db.herstellerReklamationen.splice(idx, 1);
  speichereDB(db);
  io.emit('hersteller_geloescht', { id: parseInt(req.params.id) });
  res.json({ ok: true });
});

app.get('/api/hersteller/statistik', (req, res) => {
  const alle    = db.herstellerReklamationen;
  const heute   = new Date().toISOString().slice(0, 10);
  const erledigt    = alle.filter(r => r.status === 'erledigt').length;
  const offen       = alle.filter(r => r.status === 'offen').length;
  const gesendet    = alle.filter(r => r.status === 'gesendet').length;
  const rueckmeldung = alle.filter(r => r.status === 'rueckmeldung').length;
  const erinnerungen = alle.filter(r =>
    r.status !== 'erledigt' && r.erinnerung_datum && r.erinnerung_datum <= heute
  ).length;
  res.json({ gesamt: alle.length, offen, gesendet, rueckmeldung, erledigt, erinnerungen });
});

// ── Erinnerungs-E-Mails (stündlich prüfen) ───────────────
async function pruefeErinnerungen() {
  const heute = new Date().toISOString().slice(0, 10);
  let geaendert = false;
  for (const r of db.herstellerReklamationen) {
    if (r.status === 'erledigt') continue;
    for (const e of (r.erinnerungen || [])) {
      if (!e.datum || e.gesendet_am) continue;
      if (e.datum <= heute) {
        await sendeErinnerungsMail(r, e.datum);
        e.gesendet_am = new Date().toISOString();
        geaendert = true;
      }
    }
    // erinnerung_datum = früheste noch nicht gesendete Erinnerung
    const pending = (r.erinnerungen || []).filter(e => !e.gesendet_am && e.datum);
    r.erinnerung_datum = pending.length ? pending.sort((a, b) => a.datum.localeCompare(b.datum))[0].datum : null;
  }
  if (geaendert) speichereDB(db);
}
pruefeErinnerungen(); // beim Start einmal ausführen
setInterval(pruefeErinnerungen, 60 * 60 * 1000); // stündlich

// ── Automatisches Backup ──────────────────────────────────
const BACKUP_DIR = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

function backup() {
  const datum = new Date().toISOString().slice(0, 10);
  const ziel  = path.join(BACKUP_DIR, `reklamationen_${datum}.json`);
  if (fs.existsSync(ziel)) return; // heute schon gesichert
  fs.copyFileSync(DB_FILE, ziel);
  console.log(`  Backup erstellt: reklamationen_${datum}.json`);

  // Backups älter als 30 Tage löschen
  const grenze = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const datei of fs.readdirSync(BACKUP_DIR)) {
    const voll = path.join(BACKUP_DIR, datei);
    if (fs.statSync(voll).mtimeMs < grenze) {
      fs.unlinkSync(voll);
      console.log(`  Altes Backup gelöscht: ${datei}`);
    }
  }
}

backup(); // direkt beim Start einmal sichern
setInterval(backup, 60 * 60 * 1000); // stündlich prüfen (sichert nur einmal pro Tag)

// ── Socket.IO ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Nutzer verbunden:', socket.id);
  socket.on('disconnect', () => console.log('Nutzer getrennt:', socket.id));
});

// ── Server starten ────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║       Reklamationen  v1.1           ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log(`\n  Lokal:    http://localhost:${PORT}`);
  console.log(`  Netzwerk: http://${localIP}:${PORT}`);
  console.log('\n  Zum Beenden: Strg+C\n');
});
