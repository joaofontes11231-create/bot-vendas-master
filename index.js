require('dotenv').config();
const { initDB } = require('./database');
const { startBot } = require('./bot');
const { startWeb } = require('./web');

async function main() {
  // 1. Sobe o painel web na porta do ambiente (Railway/Render)
  startWeb();

  // 2. Conecta ao banco Turso
  await initDB();

  // 3. Inicia o bot do Discord
  await startBot();
}

main().catch((err) => {
  console.error('❌ Erro fatal na inicialização:', err);
  process.exit(1);
});
