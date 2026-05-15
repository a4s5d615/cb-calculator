@echo off
chcp 65001 > nul
echo.
echo  ================================
echo   可轉債競標計算機啟動中...
echo  ================================
echo.
cd /d "%~dp0"
node server.js
pause
