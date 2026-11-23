const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS licenses (
      guild_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      store_name TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      expires_at INTEGER NOT NULL,
      mp_token TEXT DEFAULT ''
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      stock TEXT DEFAULT '[]'
    )
  `);
}

module.exports = {
  initDB,

  async getLicense(guildId) {
    const res = await db.execute({
      sql: 'SELECT * FROM licenses WHERE guild_id = ?',
      args: [guildId]
    });
    const lic = res.rows[0];
    if (!lic) return null;

    const now = Date.now();
    const daysLeft = Math.ceil((Number(lic.expires_at) - now) / (1000 * 60 * 60 * 24));
    return {
      ...lic,
      active: Number(lic.active),
      daysLeft: daysLeft > 0 ? daysLeft : 0,
      isExpired: now > Number(lic.expires_at)
    };
  },

  async getAllLicenses() {
    const res = await db.execute('SELECT * FROM licenses');
    const now = Date.now();
    return res.rows.map(lic => {
      const daysLeft = Math.ceil((Number(lic.expires_at) - now) / (1000 * 60 * 60 * 24));
      return {
        ...lic,
        active: Number(lic.active),
        daysLeft: daysLeft > 0 ? daysLeft : 0,
        isExpired: now > Number(lic.expires_at)
      };
    });
  },

  async upsertLicense(guildId, ownerId, storeName, days) {
    const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    await db.execute({
      sql: `INSERT INTO licenses (guild_id, owner_id, store_name, active, expires_at)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(guild_id) DO UPDATE SET
            owner_id = excluded.owner_id,
            store_name = excluded.store_name,
            active = 1,
            expires_at = excluded.expires_at`,
      args: [guildId, ownerId, storeName, expiresAt]
    });
  },

  async setLicenseStatus(guildId, active) {
    await db.execute({
      sql: 'UPDATE licenses SET active = ? WHERE guild_id = ?',
      args: [active ? 1 : 0, guildId]
    });
  },

  async addDays(guildId, extraDays) {
    const lic = await this.getLicense(guildId);
    if (!lic) return;
    const baseTime = Number(lic.expires_at) > Date.now() ? Number(lic.expires_at) : Date.now();
    const newExpires = baseTime + extraDays * 24 * 60 * 60 * 1000;
    await db.execute({
      sql: 'UPDATE licenses SET expires_at = ?, active = 1 WHERE guild_id = ?',
      args: [newExpires, guildId]
    });
  },

  async deleteLicense(guildId) {
    await db.execute({ sql: 'DELETE FROM licenses WHERE guild_id = ?', args: [guildId] });
    await db.execute({ sql: 'DELETE FROM products WHERE guild_id = ?', args: [guildId] });
  },

  async setMpToken(guildId, token) {
    await db.execute({
      sql: 'UPDATE licenses SET mp_token = ? WHERE guild_id = ?',
      args: [token, guildId]
    });
  },

  async addProduct(guildId, name, description, price) {
    const res = await db.execute({
      sql: 'INSERT INTO products (guild_id, name, description, price) VALUES (?, ?, ?, ?)',
      args: [guildId, name, description, price]
    });
    return { lastInsertRowid: Number(res.lastInsertRowid) };
  },

  async getProduct(id, guildId) {
    const res = await db.execute({
      sql: 'SELECT * FROM products WHERE id = ? AND guild_id = ?',
      args: [id, guildId]
    });
    return res.rows[0] || null;
  },

  async addStock(productId, guildId, itemsArray) {
    const prod = await this.getProduct(productId, guildId);
    if (!prod) return false;
    const currentStock = JSON.parse(prod.stock || '[]');
    const updated = currentStock.concat(itemsArray);
    await db.execute({
      sql: 'UPDATE products SET stock = ? WHERE id = ?',
      args: [JSON.stringify(updated), productId]
    });
    return updated.length;
  },

  async popStockItem(productId, guildId) {
    const prod = await this.getProduct(productId, guildId);
    if (!prod) return null;
    const currentStock = JSON.parse(prod.stock || '[]');
    if (currentStock.length === 0) return null;
    const item = currentStock.shift();
    await db.execute({
      sql: 'UPDATE products SET stock = ? WHERE id = ?',
      args: [JSON.stringify(currentStock), productId]
    });
    return item;
  }
};