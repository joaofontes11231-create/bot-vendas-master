require('dotenv').config();
const { initDB } = require('./database');
const { startBot } = require('./bot');
const { startWeb } = require('./web');

(async () => {
  await initDB();
  startBot();
  startWeb();
})();