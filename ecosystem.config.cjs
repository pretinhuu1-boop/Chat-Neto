const path = require('path');
const fs   = require('fs');

// Lê o .env e injeta no env do PM2 (garante que a chave carrega independente do CWD)
const envVars = { NODE_ENV: 'production' };
try {
  const envFile = path.join(__dirname, '.env');
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.+)$/);
    if (m) envVars[m[1]] = m[2].trim();
  });
} catch {}

module.exports = {
  apps: [
    {
      name: 'salemaker',
      script: 'server.js',
      cwd: __dirname,
      node_args: '--experimental-sqlite',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      env: envVars,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
    },
  ],
};
