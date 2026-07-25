@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  start "Music Player Local Server" /D "%~dp0" py -m http.server 8000
) else (
  start "Music Player Local Server" /D "%~dp0" python -m http.server 8000
)

timeout /t 2 /nobreak >nul
start "" "http://localhost:8000/"
echo The local server is running in a separate window.
echo Use it for initial installation or testing updates, then close that server window when finished.
endlocal
