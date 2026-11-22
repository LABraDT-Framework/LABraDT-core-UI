@echo off
rem LABraDT UI: create the virtual environment once, then start the UI controller on http://localhost:8090
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment ...
  python -m venv .venv || goto :error
  ".venv\Scripts\python" -m pip install -r requirements.txt paho-mqtt || goto :error
)
echo Starting LABraDT UI on http://localhost:8090  (Ctrl+C to stop)
start "" http://localhost:8090/#system
".venv\Scripts\python" app.py
goto :eof
:error
echo Setup failed. Install Python 3.12 and try again.
exit /b 1
