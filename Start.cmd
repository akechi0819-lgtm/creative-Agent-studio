@echo off
setlocal
set "ROOT=%~dp0"
set "NODE_EXE=%ROOT%.studio-runtime\node\node-v22.23.3-win-x64\node.exe"

if not exist "%NODE_EXE%" (
  echo 成品包内的 Node.js 缺失，请重新解压完整成品包。 1>&2
  exit /b 1
)

pushd "%ROOT%" || exit /b 1
"%NODE_EXE%" "%ROOT%scripts\setup.mjs" %*
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
