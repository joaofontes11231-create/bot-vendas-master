require('dotenv').config();

const { initDB } = require('./database');
const { startBot } = require('./bot');
const { startWeb } = require('./web');

async function main() {
  // Não aceite tráfego antes de confirmar que o schema do banco está pronto.
  await initDB();

  // O servidor web fica disponível para health checks antes do login do Discord.
  await startWeb();

  // Há apenas um ponto de entrada para iniciar o bot, evitando logins duplicados.
  await startBot();
}

main().catch((err) => {
  console.error('❌ Erro fatal na inicialização:', err);
  process.exit(1);
});
