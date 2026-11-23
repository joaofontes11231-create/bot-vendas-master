require('dotenv').config();
const { initDB } = require('./database');
const { startBot } = require('./bot');
const { startWeb } = require('./web');

(async () => {
  try {
    await initDB();
    console.log('✅ Banco Turso conectado.');
  } catch (err) {
    console.error('❌ Falha ao iniciar banco Turso:', err);
  }

  try {
    await startBot();
  } catch (err) {
    console.error('❌ Falha ao fazer login no Discord:', err);
  }

  startWeb();
})();
