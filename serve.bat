@echo off
REM Start a local HTTP server for GlassChess (WebGPU needs http://, not file://).
REM Double-click to run, then open the page in Chrome/Edge 113+.

cd /d "%~dp0"

echo ================================================
echo  GlassChess server
echo ================================================
echo  Open : http://localhost:8000/
echo.
echo  Opening browser... Press Ctrl+C to stop the server.
echo ================================================

REM Open in Edge (not the default browser) shortly after, so the server has time to bind the port.
start "" /min cmd /c "timeout /t 1 >nul & start msedge http://localhost:8000/"

python -m http.server 8000
