const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('JavaScript entry points parse without syntax errors', () => {
  for (const file of ['index.js', 'bot.js', 'database.js', 'web.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
    assert.equal(result.status, 0, file + ': ' + result.stderr);
  }
});

test('public customer panel never renders hosting access credentials', () => {
  const bot = read('bot.js');
  const start = bot.indexOf('async function renderCustomerFixedPanel');
  const end = bot.indexOf('async function refreshAllFixedPanels', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const renderer = bot.slice(start, end);
  assert.doesNotMatch(renderer, /latest\.access_info/);
  assert.match(renderer, /somente por mensagem privada/i);
});

test('production web startup requires strong credentials', () => {
  const web = read('web.js');
  assert.match(web, /masterPassword\.length < 12/);
  assert.match(web, /configuredSessionSecret\.length < 32/);
  assert.match(web, /httpOnly: true/);
  assert.match(web, /sameSite: 'lax'/);
});

test('database enforces a single active renewal order for each hosting', () => {
  const database = read('database.js');
  assert.match(database, /CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_renewal/);
  assert.match(database, /status IN \('pending', 'processing'\)/);
  assert.match(database, /status = 'superseded'/);
});

test('startup initializes the database before accepting traffic or logging into Discord', () => {
  const index = read('index.js');
  assert.ok(index.indexOf('await initDB()') < index.indexOf('await startWeb()'));
  assert.ok(index.indexOf('await startWeb()') < index.indexOf('await startBot()'));
});

test('APP_ROLE gates the web and bot services independently', () => {
  const index = read('index.js');
  assert.match(index, /\['all', 'web', 'bot'\]/);
  assert.match(index, /role === 'all' \|\| role === 'web'/);
  assert.match(index, /role === 'all' \|\| role === 'bot'/);
  assert.match(index, /APP_ROLE inválido/);
});

test('environment template contains variable names but no populated secrets', () => {
  const env = read('.env.example');
  for (const line of env.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    assert.match(line, /^(?:[A-Z0-9_]+=\\s*|APP_ROLE=all|REGISTER_COMMANDS=false|NODE_ENV=production|PORT=8080|MP_MODE=production)$/);
  }
});
