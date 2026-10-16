@echo off
setlocal
set "NO_ARGS=0"
if "%~1"=="" set "NO_ARGS=1"
set "ROOT=%~dp0"
set "NODE_EXE="
for /f "usebackq delims=" %%N in (`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\bootstrap-node.ps1" -Root "%ROOT%"`) do set "NODE_EXE=%%N"
if not defined NODE_EXE (
  echo Node.js bootstrap did not return an executable path. 1>&2
  if "%NO_ARGS%"=="1" pause
  exit /b 1
)
pushd "%ROOT%" || exit /b 1
if "%~1"=="" (
  "%NODE_EXE%" "%ROOT%scripts\launcher.mjs" menu
) else (
  "%NODE_EXE%" "%ROOT%scripts\launcher.mjs" %*
)
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
