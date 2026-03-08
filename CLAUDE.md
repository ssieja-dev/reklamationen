# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Server starten

```bash
node server.js
# oder auf Windows:
start.bat
```

Port: **3001** — `start.bat` installiert Node.js und `npm install` automatisch beim ersten Start.

## Architektur

Single-Page-App ohne Build-Schritt:

- **`server.js`** — Express + Socket.IO Backend. Alle API-Routen, Session-Auth, Backup-Logik und Multer-Upload in einer Datei.
- **`public/app.js`** — Gesamte Frontend-Logik. Kein Framework, reines JS.
- **`public/index.html`** — Alle Modals sind statisch im HTML, werden per `.hidden`-Klasse ein-/ausgeblendet.
- **`public/style.css`** — CSS-Variablen in `:root`, kein Preprocessor.
- **`reklamationen.json`** — Einzige Datenbank. Wird bei jeder Änderung komplett überschrieben.
- **`config.json`** — Enthält nur `{ "passwort": "..." }`. Hier Passwort ändern.
- **`backups/`** — Tägliche Backups von `reklamationen.json`, 30 Tage aufbewahrt, beim Server-Start und stündlich ausgelöst.
- **`uploads/`** — Hochgeladene Kundenbilder (nur JPEG/PNG, max 10 MB).

## Reklamations-Workflow (6 Schritte)

Status-Reihenfolge: `neu → an_lieferant → lieferant_entscheidung → lieferant_gutschrift → kundenloesung → erledigt`

Jeder Schritt hat eigene PATCH-Route (`/api/reklamationen/:id/<schritt>`). Status kann nur vorwärts gesetzt werden (`statusIdx`-Check). Alle Änderungen werden per Socket.IO an alle verbundenen Clients gesendet (`io.emit('reklamation_update', r)`).

## Auth

Session-basiert via `express-session`. Login über `POST /api/login` mit Passwort aus `config.json`. Alle `/api/*`-Routen außer `/api/login` sind ohne gültige Session gesperrt (401). Session-Dauer: 8 Stunden.

## Frontend-Muster

- `renderDetail(r)` baut den gesamten Detail-Modal-Inhalt neu auf (kein partielles Update).
- Socket.IO-Events (`reklamation_update`, `reklamation_neu`, `reklamation_geloescht`) aktualisieren `alleReklamationen[]` und rufen `renderListe()` + ggf. `renderDetail()` neu auf.
- Quelldateien liegen in `public/` (nicht `dist/`).
