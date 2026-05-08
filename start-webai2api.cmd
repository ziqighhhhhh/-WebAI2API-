@echo off
setlocal

cd /d "%~dp0"

echo ========================================
echo WebAI2API one-click starter
echo Project: %CD%
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo Please install Node.js 20 or later, then run this file again.
  pause
  exit /b 1
)

node -e "const major=Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] WebAI2API requires Node.js 20 or later.
  node -v
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [ERROR] package.json was not found. Run this script from the WebAI2API directory.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Installing dependencies with pnpm...
  corepack pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
) else (
  echo [INFO] Dependencies already installed.
)

set "NEED_INIT=0"
if not exist "camoufox\version.json" set "NEED_INIT=1"
if not exist "camoufox\GeoLite2-City.mmdb" set "NEED_INIT=1"
if not exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" set "NEED_INIT=1"

if "%NEED_INIT%"=="1" (
  echo [INFO] Initializing runtime files. This may download Camoufox and native modules.
  if defined WEBAI2API_INIT_PROXY (
    echo [INFO] Using init proxy from WEBAI2API_INIT_PROXY.
    npm run init -- "-proxy=%WEBAI2API_INIT_PROXY%"
  ) else (
    npm run init
  )
  if errorlevel 1 (
    echo [ERROR] Runtime initialization failed.
    echo If GitHub downloads are blocked, set WEBAI2API_INIT_PROXY and run this file again.
    echo Example: set WEBAI2API_INIT_PROXY=http://127.0.0.1:7890
    pause
    exit /b 1
  )
) else (
  echo [INFO] Runtime files already initialized.
)

echo.
echo [INFO] Starting WebAI2API...
echo [INFO] Web UI: http://localhost:3000
echo.
npm start

echo.
echo [INFO] WebAI2API stopped.
pause
