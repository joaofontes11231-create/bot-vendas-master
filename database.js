const { createClient } = require('@libsql/client');

let db = null;

function getClient() {
  if (db) return db;

  const url = process.env.TURSO_DATABASE_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

  if (!url || !authToken) {
    throw new Error('TURSO_DATABASE_URL ou TURSO_AUTH_TOKEN não configurados.');
  }

  db = createClient({ url, authToken });
  return db;
}

function calcDaysLeft(expiresAt) {
  if (!expiresAt) return 0;
  const diffMs = Number(expiresAt) - Date.now();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

function formatLicense(row) {
  if (!row) return null;
  const now = Date.now();
  const expiresAt = Number(row.expires_at || 0);
  const isExpired = expiresAt <= now;
  const active = Boolean(row.active);

  return {
    guild_id: String(row.guild_id),
    owner_id: String(row.owner_id),
    store_name: String(row.store_name || 'Loja Sem Nome'),
    mp_token: row.mp_token ? String(row.mp_token) : null,
    store_photo: row.store_photo ? String(row.store_photo) : null,
    active,
    expires_at: expiresAt,
    isExpired,
    daysLeft: calcDaysLeft(expiresAt),
    isOperational: active && !isExpired
  };
}

async function ensureColumn(client, table, column, definition) {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((col) => col.name === column);
  if (!exists) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initDB() {
  const client = getClient();

  await client.execute(`
    CREATE TABLE IF NOT EXISTS licenses (
      guild_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      store_name TEXT NOT NULL,
      mp_token TEXT,
      store_photo TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER NOT NULL
    )
  `);

  await ensureColumn(client, 'licenses', 'store_photo', 'TEXT');

  await client.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price REAL NOT NULL,
      stock TEXT NOT NULL DEFAULT '[]'
    )
  `);

  // Teste rápido de conexão
  await client.execute('SELECT 1');
  console.log('✅ Banco Turso conectado.');
  return client;
}

async function getLicense(guildId) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM licenses WHERE guild_id = ? LIMIT 1',
    args: [String(guildId).trim()]
  });
  return formatLicense(res.rows[0]);
}

async function getAllLicenses() {
  const client = getClient();
  const res = await client.execute('SELECT * FROM licenses ORDER BY expires_at DESC');
  return res.rows.map(formatLicense);
}

async function getLicensesByOwner(ownerId) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM licenses WHERE owner_id = ? ORDER BY store_name ASC',
    args: [String(ownerId).trim()]
  });
  return res.rows.map(formatLicense);
}

async function upsertLicense(guildId, ownerId, storeName, days) {
  const client = getClient();
  const gid = String(guildId).trim();
  const oid = String(ownerId).trim();
  const name = String(storeName).trim();
  const numDays = Math.max(1, Number(days) || 1);

  const current = await getLicense(gid);
  const baseTime = current && current.expires_at > Date.now() ? current.expires_at : Date.now();
  const expiresAt = baseTime + numDays * 24 * 60 * 60 * 1000;

  await client.execute({
    sql: `
      INSERT INTO licenses (guild_id, owner_id, store_name, mp_token, store_photo, active, expires_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        owner_id = excluded.owner_id,
        store_name = excluded.store_name,
        active = 1,
        expires_at = excluded.expires_at
    `,
    args: [
      gid,
      oid,
      name,
      current?.mp_token || null,
      current?.store_photo || null,
      expiresAt
    ]
  });

  return getLicense(gid);
}

async function updateLicenseDetails(guildId, { ownerId, storeName, days, active }) {
  const client = getClient();
  const gid = String(guildId).trim();
  const current = await getLicense(gid);
  if (!current) return null;

  const nextOwnerId = ownerId ? String(ownerId).trim() : current.owner_id;
  const nextStoreName = storeName ? String(storeName).trim() : current.store_name;
  const nextActive = typeof active === 'boolean' ? (active ? 1 : 0) : (current.active ? 1 : 0);

  let nextExpiresAt = current.expires_at;
  if (typeof days === 'number' && !Number.isNaN(days) && days >= 0) {
    nextExpiresAt = Date.now() + Math.floor(days) * 24 * 60 * 60 * 1000;
  }

  await client.execute({
    sql: `
      UPDATE licenses
      SET owner_id = ?, store_name = ?, active = ?, expires_at = ?
      WHERE guild_id = ?
    `,
    args: [nextOwnerId, nextStoreName, nextActive, nextExpiresAt, gid]
  });

  return getLicense(gid);
}

async function setLicenseStatus(guildId, active) {
  const client = getClient();
  const gid = String(guildId).trim();
  await client.execute({
    sql: 'UPDATE licenses SET active = ? WHERE guild_id = ?',
    args: [active ? 1 : 0, gid]
  });
  return getLicense(gid);
}

async function setMpToken(guildId, token) {
  const client = getClient();
  await client.execute({
    sql: 'UPDATE licenses SET mp_token = ? WHERE guild_id = ?',
    args: [String(token).trim(), String(guildId).trim()]
  });
}

async function setStorePhoto(guildId, photoUrl) {
  const client = getClient();
  const cleanUrl = photoUrl ? String(photoUrl).trim() : null;
  await client.execute({
    sql: 'UPDATE licenses SET store_photo = ? WHERE guild_id = ?',
    args: [cleanUrl, String(guildId).trim()]
  });
  return getLicense(guildId);
}

async function addProduct(guildId, name, description, price) {
  const client = getClient();
  const res = await client.execute({
    sql: 'INSERT INTO products (guild_id, name, description, price, stock) VALUES (?, ?, ?, ?, ?)',
    args: [String(guildId).trim(), String(name).trim(), String(description).trim(), Number(price), '[]']
  });

  const lastInsertRowid = Number(res.lastInsertRowid);
  return { lastInsertRowid, id: lastInsertRowid };
}

async function getProduct(productId, guildId) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM products WHERE id = ? AND guild_id = ? LIMIT 1',
    args: [Number(productId), String(guildId).trim()]
  });
  return res.rows[0] || null;
}

async function getProductsByGuild(guildId) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM products WHERE guild_id = ? ORDER BY id ASC',
    args: [String(guildId).trim()]
  });
  return res.rows;
}

async function updateProduct(productId, guildId, { name, description, price }) {
  const client = getClient();
  const current = await getProduct(productId, guildId);
  if (!current) return null;

  const nextName = name ? String(name).trim() : current.name;
  const nextDesc = description ? String(description).trim() : current.description;
  const nextPrice = typeof price === 'number' && !Number.isNaN(price) ? Number(price) : Number(current.price);

  await client.execute({
    sql: 'UPDATE products SET name = ?, description = ?, price = ? WHERE id = ? AND guild_id = ?',
    args: [nextName, nextDesc, nextPrice, Number(productId), String(guildId).trim()]
  });

  return getProduct(productId, guildId);
}

async function deleteProduct(productId, guildId) {
  const client = getClient();
  const current = await getProduct(productId, guildId);
  if (!current) return false;

  await client.execute({
    sql: 'DELETE FROM products WHERE id = ? AND guild_id = ?',
    args: [Number(productId), String(guildId).trim()]
  });
  return true;
}

async function addStock(productId, guildId, newItems) {
  const client = getClient();
  const prod = await getProduct(productId, guildId);
  if (!prod) return false;

  const stock = JSON.parse(prod.stock || '[]');
  stock.push(...newItems);

  await client.execute({
    sql: 'UPDATE products SET stock = ? WHERE id = ? AND guild_id = ?',
    args: [JSON.stringify(stock), Number(productId), String(guildId).trim()]
  });

  return stock.length;
}

async function popStockItem(productId, guildId) {
  const client = getClient();
  const prod = await getProduct(productId, guildId);
  if (!prod) return null;

  const stock = JSON.parse(prod.stock || '[]');
  if (stock.length === 0) return null;

  const item = stock.shift();
  await client.execute({
    sql: 'UPDATE products SET stock = ? WHERE id = ? AND guild_id = ?',
    args: [JSON.stringify(stock), Number(productId), String(guildId).trim()]
  });

  return item;
}

module.exports = {
  initDB,
  getLicense,
  getAllLicenses,
  getLicensesByOwner,
  upsertLicense,
  updateLicenseDetails,
  setLicenseStatus,
  setMpToken,
  setStorePhoto,
  addProduct,
  getProduct,
  getProductsByGuild,
  updateProduct,
  deleteProduct,
  addStock,
  popStockItem
};
