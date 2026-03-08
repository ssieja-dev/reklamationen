@echo off
chcp 65001 >nul
title Reklamationen v1.0

echo.
echo  ╔══════════════════════════════════════╗
echo  ║       Reklamationen  v1.0           ║
echo  ╚══════════════════════════════════════╝
echo.

:: Node.js suchen
set NODE_EXE=
if exist "C:\Program Files\nodejs\node.exe" set NODE_EXE=C:\Program Files\nodejs\node.exe
if exist "C:\Program Files (x86)\nodejs\node.exe" set NODE_EXE=C:\Program Files (x86)\nodejs\node.exe
where node >nul 2>&1 && set NODE_EXE=node

if "%NODE_EXE%"=="" (
  echo  [INFO] Node.js nicht gefunden. Wird installiert...
  echo.
  winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if %errorlevel% neq 0 (
    echo.
    echo  [FEHLER] Installation fehlgeschlagen.
    echo  Bitte Node.js manuell installieren: https://nodejs.org
    pause
    exit /b 1
  )
  echo.
  echo  [OK] Node.js installiert.
  echo  Bitte dieses Fenster schliessen und start.bat erneut ausfuehren.
  pause
  exit /b 0
)

:: Abhaengigkeiten pruefen und installieren
if not exist node_modules (
  echo  [INFO] Pakete werden installiert (einmalig)...

  set NPM_EXE=
  if exist "C:\Program Files\nodejs\npm.cmd" set NPM_EXE=C:\Program Files\nodejs\npm.cmd
  if exist "C:\Program Files (x86)\nodejs\npm.cmd" set NPM_EXE=C:\Program Files (x86)\nodejs\npm.cmd

  if "%NPM_EXE%"=="" (
    echo  [FEHLER] npm nicht gefunden.
    pause
    exit /b 1
  )
  "%NPM_EXE%" install
  if %errorlevel% neq 0 (
    echo  [FEHLER] Paketinstallation fehlgeschlagen.
    pause
    exit /b 1
  )
  echo.
)

:: IP-Adresse ermitteln
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  set IP=%%a
  goto :got_ip
)
:got_ip
set IP=%IP: =%

echo  [OK] Server startet...
echo.
echo  ┌─────────────────────────────────────────┐
echo  │                                         │
echo  │  Lokal:    http://localhost:3001        │
echo  │  Netzwerk: http://%IP%:3001      │
echo  │                                         │
echo  │  Andere Geraete im gleichen WLAN        │
echo  │  einfach die Netzwerk-Adresse           │
echo  │  im Browser aufrufen.                   │
echo  │                                         │
echo  └─────────────────────────────────────────┘
echo.
echo  Zum Beenden: Dieses Fenster schliessen oder Strg+C
echo.

"%NODE_EXE%" server.js

pause
