@echo off
chcp 65001 >nul
cd /d "C:\Users\SUM_e\Downloads\nav-app"

echo nav-app 로컬 서버를 시작합니다 (localhost:8000)...
echo 이 창을 닫으면 서버도 함께 꺼집니다.
echo.

start "" cmd /c "timeout /t 2 >nul & start http://localhost:8000"
npx --yes serve -l 8000
