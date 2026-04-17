@echo off
setlocal enabledelayedexpansion

rem @alchemy/cli-win32 launcher
rem
rem Resolves the alchemy CLI entrypoint via node/bun module resolution.
rem Runtime selection:
rem   1. If the invoking package manager is bun (%npm_execpath% contains "bun"), use bun.
rem   2. Otherwise, if `bun` is on PATH, prefer it.
rem   3. Otherwise fall back to node.

set "RUNTIME=node"
if defined npm_execpath (
  echo %npm_execpath% | findstr /I "bun" >nul && set "RUNTIME=bun"
)
if "!RUNTIME!"=="node" (
  where bun >nul 2>nul && set "RUNTIME=bun"
)

for /f "usebackq delims=" %%i in (`!RUNTIME! -e "console.log(require.resolve('alchemy/bin/alchemy.js'))"`) do set "ENTRY=%%i"

!RUNTIME! "!ENTRY!" %*
exit /b %ERRORLEVEL%
