require('dotenv').config();

const { initDB } = require('./database');
const { startBot } = require('./bot');
const { startWeb } = require('./web');

async function main() {
  const role = String(process.env.APP_ROLE || 'all').trim().toLowerCase();
  if (!['all', 'web', 'bot'].includes(role)) {
    throw new Error('APP_ROLE inválido. Use all, web ou bot.');
  }

  // Cada serviço inicializa o schema compartilhado antes de atender sua função.
  await initDB();

  if (role === 'all' || role === 'web') {
    await startWeb();
  }

  if (role === 'all' || role === 'bot') {
    await startBot();
  }

  console.log(`✅ Serviço iniciado. APP_ROLE=${role}`);
}

main().catch((err) => {
  console.error('❌ Erro fatal na inicialização:', err);
  process.exit(1);
});
