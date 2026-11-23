require('dotenv').config();
const { initDB } = require('./database');
const { startBot } = require('./bot');
const { startWeb } = require('./web');

(async () => {
  // 1. Sobe o painel web na porta do Render imediatamente
  startWeb();

  // 2. Conecta ao banco Turso
  try {
    await initDB();
    console.log('✅ Banco Turso conectado.');
  } catch (err) {
    console.error('❌ Falha ao iniciar banco Turso:', err);
  }

  // 3. Inicia o bot do Discord
  try {
    await startBot();
  } catch (err) {
    console.error('❌ Falha ao fazer login no Discord:', err);
  }
})();
