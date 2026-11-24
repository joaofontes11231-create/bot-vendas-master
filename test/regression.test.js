const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('JavaScript entry points parse without syntax errors', () => {
  for (const file of ['index.js', 'bot.js', 'database.js', 'web.js', 'mercadopago.js']) {
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
  const safeDefaults = new Set(['APP_ROLE=all', 'REGISTER_COMMANDS=false', 'NODE_ENV=production', 'PORT=8080', 'MP_MODE=production']);
  for (const line of env.split(/\\r?\\n/)) {
    if (!line || line.startsWith('#')) continue;
    assert.ok(/^[A-Z0-9_]+=$/.test(line) || safeDefaults.has(line), 'Unexpected populated environment value: ' + line);
  }
});

test('Mercado Pago access and refresh tokens are authenticated-encrypted', () => {
  const mp = require('../mercadopago');
  process.env.MP_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
  const encrypted = mp.encryptToken('seller-access-token');
  assert.notEqual(encrypted, 'seller-access-token');
  assert.equal(mp.decryptToken(encrypted), 'seller-access-token');
  assert.throws(() => mp.decryptToken(encrypted + 'tampered'));
});

test('Mercado Pago webhook HMAC follows the documented signed manifest', () => {
  const crypto = require('node:crypto');
  const mp = require('../mercadopago');
  const secret = 'test-webhook-secret';
  const signatureId = '123456';
  const requestId = 'request-123';
  const ts = '1704908010';
  const manifest = 'id:' + signatureId + ';request-id:' + requestId + ';ts:' + ts + ';';
  const hash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  assert.equal(mp.verifyWebhookSignature({
    signature: 'ts=' + ts + ',v1=' + hash,
    requestId,
    dataId: signatureId,
    secret
  }), true);
  assert.equal(mp.verifyWebhookSignature({
    signature: 'ts=' + ts + ',v1=' + hash,
    requestId: 'wrong-request',
    dataId: signatureId,
    secret
  }), false);
});

test('seller checkout and webhook never trust browser return URLs for payment approval', () => {
  const web = read('web.js');
  const bot = read('bot.js');
  const mp = read('mercadopago.js');
  assert.match(web, /app\.post\('\/webhooks\/mercadopago'/);
  assert.match(web, /verifyWebhookSignature/);
  assert.match(web, /payment\.collector_id/);
  assert.match(web, /payment\.transaction_amount/);
  assert.match(web, /current\.payment_provider === 'mercadopago'/);
  assert.match(bot, /createCheckoutPreference/);
  assert.match(bot, /existing\.payment_provider === 'mercadopago'/);
  assert.match(mp, /external_reference/);
  assert.match(mp, /notification_url/);
});

test('seller OAuth requires Discord owner identity, state and PKCE', () => {
  const web = read('web.js');
  const mp = read('mercadopago.js');
  assert.match(web, /sellerDiscordId/);
  assert.match(web, /safeStateEqual/);
  assert.match(web, /getOwnedStore/);
  assert.match(mp, /code_challenge_method: 'S256'/);
  assert.match(mp, /code_verifier/);
});

test('encrypted seller payment credentials are excluded from JSON backups', () => {
  const database = read('database.js');
  const backup = database.slice(database.indexOf('async function exportFullBackup'), database.indexOf('module.exports'));
  assert.doesNotMatch(backup, /mercado_pago_connections/);
});

