@echo off
echo Iniciando SaleMaker...

where pm2 >nul 2>&1
if %errorlevel% neq 0 (
  echo PM2 nao encontrado. Instalando...
  npm install -g pm2
)

if not exist .env (
  echo ERRO: arquivo .env nao encontrado!
  echo Crie o arquivo .env com sua ANTHROPIC_API_KEY
  pause
  exit /b 1
)

pm2 start ecosystem.config.cjs
pm2 save

echo.
echo SaleMaker rodando em http://localhost:3011
echo Use "pm2 logs salemaker" para ver os logs
echo Use "pm2 stop salemaker" para parar
pause
