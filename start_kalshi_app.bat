@echo off
cd /d "%~dp0"
start "Kalshi Server" /min python server.py
timeout /t 2 /nobreak >nul
start "" "http://localhost:5000/index.html"
