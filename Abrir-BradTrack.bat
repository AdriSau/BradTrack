@echo off
setlocal
set "URL=http://127.0.0.1:8765/"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $response = Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 (
    start "BradTrack" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-BradTrack.ps1"
)

for /l %%i in (1,1,30) do (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $response = Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
    if not errorlevel 1 (
        start "" "%URL%"
        exit /b 0
    )
    timeout /t 1 /nobreak >nul
)

echo No se pudo iniciar BradTrack. Revisa la ventana de PowerShell.
pause
