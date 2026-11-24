const { createClient } = require('@libsql/client');
const { randomBytes } = require('node:crypto');

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
    server_name: row.server_name ? String(row.server_name) : String(row.store_name || 'Servidor'),
    owner_id: String(row.owner_id),
    store_name: String(row.store_name || 'Hospedagem'),
    pix_key: row.pix_key ? String(row.pix_key) : null,
    store_photo: row.store_photo ? String(row.store_photo) : null,
    logs_channel_id: row.logs_channel_id ? String(row.logs_channel_id) : null,
    block_reason: row.block_reason ? String(row.block_reason) : null,
    maintenance: Boolean(row.maintenance),
    active,
    expires_at: expiresAt,
    isExpired,
    daysLeft: calcDaysLeft(expiresAt),
    isOperational: active && !isExpired && !Boolean(row.maintenance)
  };
}

function formatHosting(row) {
  if (!row) return null;
  const now = Date.now();
  const expiresAt = Number(row.expires_at || 0);
  const isExpired = expiresAt <= now;
  const status = String(row.status || 'active');

  return {
    id: Number(row.id),
    code: String(row.code),
    guild_id: String(row.guild_id),
    customer_id: String(row.customer_id),
    plan_name: String(row.plan_name),
    specs: String(row.specs || ''),
    price: Number(row.price || 0),
    status: isExpired && status === 'active' ? 'expired' : status,
    created_at: Number(row.created_at || now),
    expires_at: expiresAt,
    daysLeft: calcDaysLeft(expiresAt),
    access_info: row.access_info ? String(row.access_info) : ''
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
      server_name TEXT,
      owner_id TEXT NOT NULL,
      store_name TEXT NOT NULL,
      pix_key TEXT,
      store_photo TEXT,
      logs_channel_id TEXT,
      block_reason TEXT,
      maintenance INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER NOT NULL
    )
  `);

  await ensureColumn(client, 'licenses', 'server_name', 'TEXT');
  await ensureColumn(client, 'licenses', 'pix_key', 'TEXT');
  await ensureColumn(client, 'licenses', 'store_photo', 'TEXT');
  await ensureColumn(client, 'licenses', 'logs_channel_id', 'TEXT');
  await ensureColumn(client, 'licenses', 'block_reason', 'TEXT');
  await ensureColumn(client, 'licenses', 'maintenance', 'INTEGER NOT NULL DEFAULT 0');

  await client.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price REAL NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 30,
      specs TEXT NOT NULL DEFAULT ''
    )
  `);

  await ensureColumn(client, 'products', 'duration_days', 'INTEGER NOT NULL DEFAULT 30');
  await ensureColumn(client, 'products', 'specs', "TEXT NOT NULL DEFAULT ''");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT UNIQUE NOT NULL,
      guild_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      plan_name TEXT NOT NULL,
      original_price REAL NOT NULL,
      final_price REAL NOT NULL,
      coupon_code TEXT,
      duration_days INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'pending',
      hosting_code TEXT,
      created_at INTEGER NOT NULL,
      approved_at INTEGER,
      renewal_hosting_code TEXT
    )
  `);

  await ensureColumn(client, 'orders', 'renewal_hosting_code', 'TEXT');
  await ensureColumn(client, 'orders', 'payment_provider', 'TEXT');
  await ensureColumn(client, 'orders', 'payment_url', 'TEXT');
  await ensureColumn(client, 'orders', 'mp_preference_id', 'TEXT');
  await ensureColumn(client, 'orders', 'mp_payment_id', 'TEXT');
  await ensureColumn(client, 'orders', 'payment_status', "TEXT NOT NULL DEFAULT 'unpaid'");
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_mp_payment_id ON orders(mp_payment_id) WHERE mp_payment_id IS NOT NULL");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS mercado_pago_connections (
      guild_id TEXT PRIMARY KEY,
      mp_user_id TEXT NOT NULL UNIQUE,
      nickname TEXT,
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Keep one active renewal order per customer and hosting; collapse legacy duplicates first.
  await client.execute(`
    UPDATE orders
    SET status = 'superseded'
    WHERE renewal_hosting_code IS NOT NULL
      AND status IN ('pending', 'processing')
      AND id NOT IN (
        SELECT MAX(id)
        FROM orders
        WHERE renewal_hosting_code IS NOT NULL
          AND status IN ('pending', 'processing')
        GROUP BY guild_id, customer_id, renewal_hosting_code
      )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_renewal
    ON orders(guild_id, customer_id, renewal_hosting_code)
    WHERE renewal_hosting_code IS NOT NULL AND status IN ('pending', 'processing')
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS hostings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      guild_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      plan_name TEXT NOT NULL,
      specs TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      access_info TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      source_order_id INTEGER
    )
  `);

  await ensureColumn(client, 'hostings', 'source_order_id', 'INTEGER');
  await ensureColumn(client, 'hostings', 'last_renewal_order_id', 'INTEGER');
  await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_hostings_source_order ON hostings(source_order_id) WHERE source_order_id IS NOT NULL');

  await client.execute(`
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      code TEXT NOT NULL,
      discount_percent INTEGER NOT NULL,
      uses_left INTEGER NOT NULL DEFAULT 100
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS fixed_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      panel_type TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref_key TEXT UNIQUE NOT NULL,
      sent_at INTEGER NOT NULL
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      stars INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Recupera pedidos que foram interrompidos durante a entrega/renovação.
  await client.execute({
    sql: `UPDATE orders
      SET status = 'approved',
          hosting_code = (SELECT h.code FROM hostings h WHERE h.source_order_id = orders.id),
          approved_at = COALESCE(approved_at, ?)
      WHERE status = 'processing'
        AND renewal_hosting_code IS NULL
        AND EXISTS (SELECT 1 FROM hostings h WHERE h.source_order_id = orders.id)`,
    args: [Date.now()]
  });
  await client.execute({
    sql: `UPDATE orders
      SET status = 'approved',
          hosting_code = renewal_hosting_code,
          approved_at = COALESCE(approved_at, ?)
      WHERE status = 'processing'
        AND renewal_hosting_code IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM hostings h
          WHERE h.code = orders.renewal_hosting_code
            AND h.last_renewal_order_id = orders.id
        )`,
    args: [Date.now()]
  });
  await client.execute("UPDATE orders SET status = 'pending' WHERE status = 'processing'");

  await client.execute('SELECT 1');
  console.log('✅ Banco Turso conectado (Pacote Pro).');
  return client;
}

async function logAudit(guildId, actorId, action, details) {
  const client = getClient();
  await client.execute({
    sql: 'INSERT INTO audit_logs (guild_id, actor_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)',
    args: [String(guildId), String(actorId), String(action), String(details), Date.now()]
  });
}

async function getAuditLogs(limit = 30) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?',
    args: [Number(limit)]
  });
  return res.rows;
}

async function addReview(guildId, userId, stars) {
  const client = getClient();
  await client.execute({
    sql: 'INSERT INTO reviews (guild_id, user_id, stars, created_at) VALUES (?, ?, ?, ?)',
    args: [String(guildId), String(userId), Number(stars), Date.now()]
  });
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

async function upsertLicense(guildId, ownerId, storeName, days, serverName = null) {
  const client = getClient();
  const gid = String(guildId).trim();
  const oid = String(ownerId).trim();
  const name = String(storeName).trim();
  const srvName = serverName && String(serverName).trim() ? String(serverName).trim() : (currentFallbackName(name));
  const numDays = Math.max(1, Number(days) || 1);

  const current = await getLicense(gid);
  const resolvedServerName = serverName && String(serverName).trim()
    ? String(serverName).trim()
    : (current?.server_name || srvName);

  const baseTime = current && current.expires_at > Date.now() ? current.expires_at : Date.now();
  const expiresAt = baseTime + numDays * 24 * 60 * 60 * 1000;

  await client.execute({
    sql: `
      INSERT INTO licenses (guild_id, server_name, owner_id, store_name, pix_key, store_photo, logs_channel_id, block_reason, maintenance, active, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        server_name = excluded.server_name,
        owner_id = excluded.owner_id,
        store_name = excluded.store_name,
        block_reason = NULL,
        active = 1,
        expires_at = excluded.expires_at
    `,
    args: [
      gid,
      resolvedServerName,
      oid,
      name,
      current?.pix_key || null,
      current?.store_photo || null,
      current?.logs_channel_id || null,
      expiresAt
    ]
  });

  return getLicense(gid);
}

function currentFallbackName(name) {
  return name;
}

async function updateLicenseDetails(guildId, { ownerId, storeName, serverName, days, active, pixKey, storePhoto, logsChannelId, maintenance, blockReason }) {
  const client = getClient();
  const gid = String(guildId).trim();
  const current = await getLicense(gid);
  if (!current) return null;

  const nextOwnerId = ownerId !== undefined ? String(ownerId).trim() : current.owner_id;
  const nextStoreName = storeName !== undefined ? String(storeName).trim() : current.store_name;
  const nextServerName = serverName !== undefined ? (String(serverName).trim() || current.server_name) : current.server_name;
  const nextActive = typeof active === 'boolean' ? (active ? 1 : 0) : (current.active ? 1 : 0);
  const nextMaint = typeof maintenance === 'boolean' ? (maintenance ? 1 : 0) : (current.maintenance ? 1 : 0);
  const nextPix = pixKey !== undefined ? (pixKey ? String(pixKey).trim() : null) : current.pix_key;
  const nextPhoto = storePhoto !== undefined ? (storePhoto ? String(storePhoto).trim() : null) : current.store_photo;
  const nextLogs = logsChannelId !== undefined ? (logsChannelId ? String(logsChannelId).trim() : null) : current.logs_channel_id;
  const nextReason = nextActive === 0
    ? (blockReason !== undefined ? (String(blockReason).trim() || 'Bloqueado pela administração') : (current.block_reason || 'Bloqueado pela administração'))
    : null;

  let nextExpiresAt = current.expires_at;
  if (typeof days === 'number' && !Number.isNaN(days) && days >= 0) {
    nextExpiresAt = Date.now() + Math.floor(days) * 24 * 60 * 60 * 1000;
  }

  await client.execute({
    sql: `
      UPDATE licenses
      SET owner_id = ?, server_name = ?, store_name = ?, pix_key = ?, store_photo = ?, logs_channel_id = ?, block_reason = ?, maintenance = ?, active = ?, expires_at = ?
      WHERE guild_id = ?
    `,
    args: [nextOwnerId, nextServerName, nextStoreName, nextPix, nextPhoto, nextLogs, nextReason, nextMaint, nextActive, nextExpiresAt, gid]
  });

  return getLicense(gid);
}

async function setLicenseStatus(guildId, active, blockReason = null) {
  return updateLicenseDetails(guildId, { active: Boolean(active), blockReason });
}

async function deleteLicense(guildId) {
  const client = getClient();
  const gid = String(guildId).trim();
  const current = await getLicense(gid);
  if (!current) return false;

  await client.execute({ sql: 'DELETE FROM products WHERE guild_id = ?', args: [gid] });
  await client.execute({ sql: 'DELETE FROM orders WHERE guild_id = ?', args: [gid] });
  await client.execute({ sql: 'DELETE FROM hostings WHERE guild_id = ?', args: [gid] });
  await client.execute({ sql: 'DELETE FROM coupons WHERE guild_id = ?', args: [gid] });
  await client.execute({ sql: 'DELETE FROM licenses WHERE guild_id = ?', args: [gid] });
  return true;
}

async function deleteOwnerAndStores(ownerId) {
  const stores = await getLicensesByOwner(ownerId);
  for (const st of stores) {
    await deleteLicense(st.guild_id);
  }
  return stores.length;
}

// PLANOS / PRODUTOS
async function addProduct(guildId, name, description, price, durationDays = 30, specs = '') {
  const client = getClient();
  const cleanName = String(name || '').trim();
  const cleanDescription = String(description || '').trim();
  const priceValue = Number(price);
  const durationValue = Number(durationDays);
  if (!cleanName || cleanName.length > 100) throw new Error('Nome do plano inválido.');
  if (!Number.isFinite(priceValue) || priceValue <= 0 || priceValue > 1000000) throw new Error('Preço do plano inválido.');
  if (!Number.isInteger(durationValue) || durationValue < 1 || durationValue > 3650) throw new Error('Duração do plano inválida.');
  const res = await client.execute({
    sql: 'INSERT INTO products (guild_id, name, description, price, duration_days, specs) VALUES (?, ?, ?, ?, ?, ?)',
    args: [String(guildId).trim(), cleanName, cleanDescription, priceValue, durationValue, String(specs || '').trim()]
  });
  const id = Number(res.lastInsertRowid);
  return { id, lastInsertRowid: id };
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

async function updateProduct(productId, guildId, { name, description, price, durationDays, specs }) {
  const client = getClient();
  const current = await getProduct(productId, guildId);
  if (!current) return null;

  await client.execute({
    sql: 'UPDATE products SET name = ?, description = ?, price = ?, duration_days = ?, specs = ? WHERE id = ? AND guild_id = ?',
    args: [
      name !== undefined ? String(name).trim() : current.name,
      description !== undefined ? String(description).trim() : current.description,
      typeof price === 'number' && !Number.isNaN(price) ? Number(price) : Number(current.price),
      typeof durationDays === 'number' && !Number.isNaN(durationDays) ? Number(durationDays) : Number(current.duration_days || 30),
      specs !== undefined ? String(specs).trim() : String(current.specs || ''),
      Number(productId),
      String(guildId).trim()
    ]
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

// CUPONS
async function createCoupon(guildId, code, discountPercent, usesLeft = 100) {
  const client = getClient();
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(cleanCode)) throw new Error('Código de cupom inválido.');
  const pct = Number(discountPercent);
  if (!Number.isInteger(pct) || pct < 1 || pct > 95) throw new Error('Desconto deve ser um número inteiro entre 1 e 95.');
  const existing = await client.execute({
    sql: 'SELECT id FROM coupons WHERE guild_id = ? AND code = ? LIMIT 1',
    args: [String(guildId).trim(), cleanCode]
  });
  if (existing.rows.length) throw new Error('Já existe um cupom com esse código nesta loja.');
  const limit = Number(usesLeft);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) throw new Error('Quantidade de usos inválida.');
  await client.execute({
    sql: 'INSERT INTO coupons (guild_id, code, discount_percent, uses_left) VALUES (?, ?, ?, ?)',
    args: [String(guildId).trim(), cleanCode, pct, limit]
  });
  return { code: cleanCode, discount_percent: pct };
}

async function applyCoupon(guildId, code) {
  if (!code) return null;
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM coupons WHERE guild_id = ? AND code = ? AND uses_left > 0 LIMIT 1',
    args: [String(guildId).trim(), String(code).trim().toUpperCase()]
  });
  return res.rows[0] || null;
}

// PEDIDOS & HOSPEDAGENS
async function createOrder(guildId, customerId, product, couponCode = null) {
  const client = getClient();
  const originalPrice = Number(product.price);
  if (!Number.isFinite(originalPrice) || originalPrice <= 0) throw new Error('Preço do pedido inválido.');
  let finalPrice = originalPrice;
  let appliedCoupon = null;

  if (couponCode) {
    const c = await applyCoupon(guildId, couponCode);
    if (c) {
      const reserved = await client.execute({
        sql: 'UPDATE coupons SET uses_left = uses_left - 1 WHERE id = ? AND uses_left > 0',
        args: [Number(c.id)]
      });
      if (Number(reserved.rowsAffected || 0) === 1) {
        appliedCoupon = c.code;
        finalPrice = Math.max(0.01, Number((originalPrice * (1 - Number(c.discount_percent) / 100)).toFixed(2)));
      }
    }
  }

  const now = Date.now();
  const tempCode = `PED-TMP-${randomBytes(8).toString('hex')}`;

  const res = await client.execute({
    sql: `
      INSERT INTO orders (order_code, guild_id, customer_id, product_id, plan_name, original_price, final_price, coupon_code, duration_days, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `,
    args: [tempCode, String(guildId).trim(), String(customerId).trim(), Number(product.id), String(product.name), originalPrice, finalPrice, appliedCoupon, Number(product.duration_days || 30), now]
  });

  const orderId = Number(res.lastInsertRowid);
  const formattedCode = `PED-${String(orderId).padStart(5, '0')}`;
  await client.execute({ sql: 'UPDATE orders SET order_code = ? WHERE id = ?', args: [formattedCode, orderId] });
  return getOrderByCode(formattedCode);
}

async function createRenewalOrder(guildId, customerId, hostingCode) {
  const gid = String(guildId).trim();
  const customer = String(customerId).trim();
  const hosting = await getHostingByCode(hostingCode);

  if (!hosting || hosting.guild_id !== gid || hosting.customer_id !== customer) {
    return null;
  }

  const client = getClient();
  const pendingRenewal = await client.execute({
    sql: "SELECT * FROM orders WHERE guild_id = ? AND customer_id = ? AND renewal_hosting_code = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    args: [gid, customer, hosting.code]
  });
  if (pendingRenewal.rows[0]) return pendingRenewal.rows[0];

  const periodRes = await client.execute({
    sql: "SELECT duration_days FROM orders WHERE hosting_code = ? AND guild_id = ? AND status = 'approved' ORDER BY approved_at DESC, id DESC LIMIT 1",
    args: [hosting.code, gid]
  });
  const durationDays = Math.max(1, Number(periodRes.rows[0]?.duration_days) || 30);

  const renewalProduct = {
    id: 0,
    name: hosting.plan_name,
    description: hosting.specs,
    price: hosting.price,
    duration_days: durationDays,
    specs: hosting.specs
  };

  const order = await createOrder(gid, customer, renewalProduct);
  try {
    await client.execute({
      sql: 'UPDATE orders SET renewal_hosting_code = ? WHERE id = ? AND status = \'pending\'',
      args: [hosting.code, Number(order.id)]
    });
  } catch (err) {
    // A simultaneous click may have created the unique active renewal first.
    await client.execute({
      sql: "UPDATE orders SET status = 'superseded' WHERE id = ? AND status = 'pending'",
      args: [Number(order.id)]
    }).catch(() => {});
    const winner = await client.execute({
      sql: "SELECT * FROM orders WHERE guild_id = ? AND customer_id = ? AND renewal_hosting_code = ? AND status IN ('pending', 'processing') ORDER BY id DESC LIMIT 1",
      args: [gid, customer, hosting.code]
    });
    if (winner.rows[0]) return winner.rows[0];
    throw err;
  }

  return getOrderByCode(order.order_code);
}

async function getOrderByCode(orderCode) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM orders WHERE order_code = ? LIMIT 1',
    args: [String(orderCode).trim().toUpperCase()]
  });
  return res.rows[0] || null;
}

async function saveMercadoPagoConnection({ guildId, mpUserId, nickname, accessTokenEnc, refreshTokenEnc, expiresAt }) {
  const client = getClient();
  await client.execute({
    sql: `INSERT INTO mercado_pago_connections
      (guild_id, mp_user_id, nickname, access_token_enc, refresh_token_enc, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        mp_user_id = excluded.mp_user_id,
        nickname = excluded.nickname,
        access_token_enc = excluded.access_token_enc,
        refresh_token_enc = excluded.refresh_token_enc,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`,
    args: [String(guildId), String(mpUserId), String(nickname || ''), String(accessTokenEnc), String(refreshTokenEnc), Number(expiresAt), Date.now(), Date.now()]
  });
}

async function getMercadoPagoConnection(guildId) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM mercado_pago_connections WHERE guild_id = ? LIMIT 1',
    args: [String(guildId)]
  });
  return res.rows[0] || null;
}

async function getMercadoPagoConnectionByUserId(mpUserId) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM mercado_pago_connections WHERE mp_user_id = ? LIMIT 1',
    args: [String(mpUserId)]
  });
  return res.rows[0] || null;
}

async function getMercadoPagoConnectionStatus(guildId) {
  const row = await getMercadoPagoConnection(guildId);
  if (!row) return null;
  return { guild_id: String(row.guild_id), mp_user_id: String(row.mp_user_id), nickname: String(row.nickname || ''), connected_at: Number(row.created_at || 0), updated_at: Number(row.updated_at || 0) };
}

async function deleteMercadoPagoConnection(guildId) {
  const client = getClient();
  const res = await client.execute({ sql: 'DELETE FROM mercado_pago_connections WHERE guild_id = ?', args: [String(guildId)] });
  return Number(res.rowsAffected || 0) > 0;
}

async function updateOrderMercadoPagoPreference(orderCode, { preferenceId, paymentUrl }) {
  const client = getClient();
  const res = await client.execute({
    sql: "UPDATE orders SET payment_provider = 'mercadopago', mp_preference_id = ?, payment_url = ?, payment_status = 'pending' WHERE order_code = ? AND status = 'pending'",
    args: [String(preferenceId), String(paymentUrl), String(orderCode).toUpperCase()]
  });
  return Number(res.rowsAffected || 0) === 1;
}

async function markOrderMercadoPagoPayment(orderCode, paymentId, paymentStatus) {
  const client = getClient();
  const res = await client.execute({
    sql: "UPDATE orders SET mp_payment_id = ?, payment_status = ? WHERE order_code = ? AND payment_provider = 'mercadopago' AND status = 'pending' AND (mp_payment_id IS NULL OR mp_payment_id = ?)",
    args: [String(paymentId), String(paymentStatus), String(orderCode).toUpperCase(), String(paymentId)]
  });
  return Number(res.rowsAffected || 0) === 1;
}

async function getOrdersByGuild(guildId) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM orders WHERE guild_id = ? ORDER BY id DESC LIMIT 50',
    args: [String(guildId).trim()]
  });
  return res.rows;
}

async function getOrdersByCustomer(customerId, guildId = null) {
  const client = getClient();
  if (guildId) {
    const res = await client.execute({
      sql: 'SELECT * FROM orders WHERE customer_id = ? AND guild_id = ? ORDER BY id DESC LIMIT 30',
      args: [String(customerId).trim(), String(guildId).trim()]
    });
    return res.rows;
  }
  const res = await client.execute({
    sql: 'SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 30',
    args: [String(customerId).trim()]
  });
  return res.rows;
}

async function approveOrderAndCreateHosting(orderCode, accessInfo = 'Liberado pelo administrador') {
  const client = getClient();
  const order = await getOrderByCode(orderCode);
  if (!order) return null;
  if (order.status === 'approved' && order.hosting_code) {
    const existingHosting = await getHostingByCode(order.hosting_code);
    return { order, hosting: existingHosting, alreadyApproved: true };
  }
  if (order.status !== 'pending') return null;

  const claim = await client.execute({
    sql: "UPDATE orders SET status = 'processing' WHERE id = ? AND status = 'pending'",
    args: [Number(order.id)]
  });
  if (Number(claim.rowsAffected || 0) !== 1) {
    const latest = await getOrderByCode(orderCode);
    if (latest?.status === 'approved' && latest.hosting_code) {
      return { order: latest, hosting: await getHostingByCode(latest.hosting_code), alreadyApproved: true };
    }
    return null;
  }

  try {
    if (order.renewal_hosting_code) {
      const current = await getHostingByCode(order.renewal_hosting_code);
      if (!current || current.guild_id !== String(order.guild_id) || current.customer_id !== String(order.customer_id)) {
        await client.execute({ sql: "UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'processing'", args: [Number(order.id)] });
        return null;
      }
      const now = Date.now();
      const durationMs = Math.max(1, Number(order.duration_days) || 30) * 24 * 60 * 60 * 1000;
      const renewed = await client.execute({
        sql: `UPDATE hostings
          SET expires_at = (CASE WHEN expires_at > ? THEN expires_at ELSE ? END) + ?,
              status = 'active', last_renewal_order_id = ?
          WHERE code = ? AND (last_renewal_order_id IS NULL OR last_renewal_order_id < ?)` ,
        args: [now, now, durationMs, Number(order.id), current.code, Number(order.id)]
      });
      const refreshed = await getHostingByCode(current.code);
      if (Number(renewed.rowsAffected || 0) === 0 && !refreshed) {
        await client.execute({ sql: "UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'processing'", args: [Number(order.id)] });
        return null;
      }
      if (Number(renewed.rowsAffected || 0) === 0) {
        const row = await client.execute({ sql: 'SELECT last_renewal_order_id FROM hostings WHERE code = ?', args: [current.code] });
        if (Number(row.rows[0]?.last_renewal_order_id) !== Number(order.id)) {
          await client.execute({ sql: "UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'processing'", args: [Number(order.id)] });
          return null;
        }
      }
      await client.execute({
        sql: "UPDATE orders SET status = 'approved', hosting_code = ?, approved_at = ? WHERE id = ? AND status = 'processing'",
        args: [current.code, Date.now(), Number(order.id)]
      });
      return { order: await getOrderByCode(orderCode), hosting: await getHostingByCode(current.code), alreadyApproved: false, renewed: true };
    }

    const product = await getProduct(order.product_id, order.guild_id);
    const now = Date.now();
    const expiresAt = now + Math.max(1, Number(order.duration_days) || 30) * 24 * 60 * 60 * 1000;
    const tempCode = 'HOS-TMP-' + randomBytes(8).toString('hex');
    await client.execute({
      sql: `INSERT OR IGNORE INTO hostings
        (code, guild_id, customer_id, plan_name, specs, price, status, access_info, created_at, expires_at, source_order_id)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      args: [tempCode, order.guild_id, order.customer_id, order.plan_name, product?.specs || product?.description || '',
        Number(order.final_price), String(accessInfo || 'Ativado'), now, expiresAt, Number(order.id)]
    });
    const hosRes = await client.execute({ sql: 'SELECT * FROM hostings WHERE source_order_id = ? LIMIT 1', args: [Number(order.id)] });
    const hostingRow = hosRes.rows[0];
    if (!hostingRow) throw new Error('Não foi possível localizar a hospedagem vinculada ao pedido.');
    const hosCode = 'HOS-' + String(hostingRow.id).padStart(5, '0');
    if (hostingRow.code !== hosCode) {
      await client.execute({ sql: 'UPDATE hostings SET code = ? WHERE id = ?', args: [hosCode, Number(hostingRow.id)] });
    }
    await client.execute({
      sql: "UPDATE orders SET status = 'approved', hosting_code = ?, approved_at = ? WHERE id = ? AND status = 'processing'",
      args: [hosCode, now, Number(order.id)]
    });
    return { order: await getOrderByCode(orderCode), hosting: await getHostingByCode(hosCode), alreadyApproved: false };
  } catch (err) {
    await client.execute({
      sql: "UPDATE orders SET status = 'pending' WHERE id = ? AND status = 'processing'",
      args: [Number(order.id)]
    }).catch(() => {});
    throw err;
  }
}

async function refundOrder(orderCode) {
  const client = getClient();
  const order = await getOrderByCode(orderCode);
  if (!order) return null;
  await client.execute({ sql: "UPDATE orders SET status = 'refunded' WHERE id = ?", args: [Number(order.id)] });
  if (order.hosting_code) {
    await client.execute({ sql: "UPDATE hostings SET status = 'suspended' WHERE code = ?", args: [order.hosting_code] });
  }
  return getOrderByCode(orderCode);
}

async function getHostingByCode(code) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM hostings WHERE code = ? LIMIT 1',
    args: [String(code).trim().toUpperCase()]
  });
  return formatHosting(res.rows[0]);
}

async function getHostingsByCustomer(customerId, guildId = null) {
  const client = getClient();
  if (guildId) {
    const res = await client.execute({
      sql: 'SELECT * FROM hostings WHERE customer_id = ? AND guild_id = ? ORDER BY id DESC',
      args: [String(customerId).trim(), String(guildId).trim()]
    });
    return res.rows.map(formatHosting);
  }
  const res = await client.execute({
    sql: 'SELECT * FROM hostings WHERE customer_id = ? ORDER BY id DESC',
    args: [String(customerId).trim()]
  });
  return res.rows.map(formatHosting);
}

async function getHostingsByGuild(guildId) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT * FROM hostings WHERE guild_id = ? ORDER BY id DESC',
    args: [String(guildId).trim()]
  });
  return res.rows.map(formatHosting);
}

async function getAllHostings() {
  const client = getClient();
  const res = await client.execute('SELECT * FROM hostings ORDER BY id DESC');
  return res.rows.map(formatHosting);
}

async function renewHosting(code, extraDays = 30) {
  const client = getClient();
  const hos = await getHostingByCode(code);
  if (!hos) return null;
  const base = hos.expires_at > Date.now() ? hos.expires_at : Date.now();
  const nextExpires = base + Math.max(1, Number(extraDays)) * 24 * 60 * 60 * 1000;
  await client.execute({ sql: "UPDATE hostings SET status = 'active', expires_at = ? WHERE code = ?", args: [nextExpires, hos.code] });
  return getHostingByCode(hos.code);
}

async function transferHostingOwner(code, newCustomerId) {
  const client = getClient();
  const hos = await getHostingByCode(code);
  if (!hos) return null;
  await client.execute({ sql: 'UPDATE hostings SET customer_id = ? WHERE code = ?', args: [String(newCustomerId).trim(), hos.code] });
  return getHostingByCode(hos.code);
}

async function updateHostingStatus(code, status, accessInfo = undefined) {
  const client = getClient();
  const hos = await getHostingByCode(code);
  if (!hos) return null;
  const nextAccess = accessInfo !== undefined ? String(accessInfo) : hos.access_info;
  await client.execute({ sql: 'UPDATE hostings SET status = ?, access_info = ? WHERE code = ?', args: [String(status), nextAccess, hos.code] });
  return getHostingByCode(hos.code);
}

async function deleteHosting(code) {
  const client = getClient();
  const hos = await getHostingByCode(code);
  if (!hos) return false;
  await client.execute({ sql: 'DELETE FROM hostings WHERE code = ?', args: [hos.code] });
  return true;
}

// PAINÉIS FIXOS 24H E NOTIFICAÇÕES
async function registerFixedPanel(panelType, guildId, targetId, channelId, messageId) {
  const client = getClient();
  await client.execute({
    sql: `
      INSERT INTO fixed_panels (panel_type, guild_id, target_id, channel_id, message_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        panel_type = excluded.panel_type,
        guild_id = excluded.guild_id,
        target_id = excluded.target_id,
        channel_id = excluded.channel_id
    `,
    args: [String(panelType), String(guildId), String(targetId), String(channelId), String(messageId)]
  });
}

async function getAllFixedPanels() {
  const client = getClient();
  const res = await client.execute('SELECT * FROM fixed_panels ORDER BY id DESC LIMIT 100');
  return res.rows;
}

async function removeFixedPanel(messageId) {
  const client = getClient();
  await client.execute({ sql: 'DELETE FROM fixed_panels WHERE message_id = ?', args: [String(messageId)] });
}

async function wasNotified(refKey) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT 1 FROM notification_logs WHERE ref_key = ? LIMIT 1',
    args: [String(refKey)]
  });
  return res.rows.length > 0;
}

async function markNotified(refKey) {
  const client = getClient();
  await client.execute({
    sql: 'INSERT OR IGNORE INTO notification_logs (ref_key, sent_at) VALUES (?, ?)',
    args: [String(refKey), Date.now()]
  });
}

async function getClientFullHistory(ownerId) {
  const stores = await getLicensesByOwner(ownerId);
  const result = [];
  for (const st of stores) {
    const products = await getProductsByGuild(st.guild_id);
    const orders = await getOrdersByGuild(st.guild_id);
    const hostings = await getHostingsByGuild(st.guild_id);
    result.push({ ...st, products, orders, hostings });
  }
  return result;
}

async function getGlobalMetrics() {
  const licenses = await getAllLicenses();
  const hostings = await getAllHostings();
  const client = getClient();
  const ordersRes = await client.execute('SELECT * FROM orders ORDER BY id DESC');
  const orders = ordersRes.rows;
  const reviewsRes = await client.execute('SELECT stars FROM reviews');
  const starsList = reviewsRes.rows.map(r => Number(r.stars || 0));
  const avgRating = starsList.length ? (starsList.reduce((a, b) => a + b, 0) / starsList.length).toFixed(1) : '5.0';

  const approvedOrders = orders.filter(o => o.status === 'approved');
  const pendingOrders = orders.filter(o => o.status === 'pending');
  const totalRevenue = approvedOrders.reduce((acc, o) => acc + Number(o.final_price || 0), 0);

  return {
    totalClients: new Set(licenses.map(l => l.owner_id)).size,
    totalStores: licenses.length,
    activeStores: licenses.filter(l => l.isOperational).length,
    totalHostings: hostings.length,
    activeHostings: hostings.filter(h => h.status === 'active').length,
    suspendedHostings: hostings.filter(h => h.status !== 'active').length,
    totalOrders: orders.length,
    approvedOrdersCount: approvedOrders.length,
    pendingOrdersCount: pendingOrders.length,
    totalRevenue,
    avgRating,
    reviewsCount: starsList.length,
    licenses,
    hostings,
    orders
  };
}

async function exportFullBackup() {
  const client = getClient();
  const [licenses, products, orders, hostings, coupons, auditLogs, reviews] = await Promise.all([
    client.execute('SELECT * FROM licenses'),
    client.execute('SELECT * FROM products'),
    client.execute('SELECT * FROM orders'),
    client.execute('SELECT * FROM hostings'),
    client.execute('SELECT * FROM coupons'),
    client.execute('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200'),
    client.execute('SELECT * FROM reviews ORDER BY id DESC LIMIT 200')
  ]);

  return {
    exportedAt: new Date().toISOString(),
    licenses: licenses.rows,
    products: products.rows,
    orders: orders.rows,
    hostings: hostings.rows,
    coupons: coupons.rows,
    auditLogs: auditLogs.rows,
    reviews: reviews.rows
  };
}

module.exports = {
  initDB,
  logAudit,
  getAuditLogs,
  addReview,
  getLicense,
  getAllLicenses,
  getLicensesByOwner,
  upsertLicense,
  updateLicenseDetails,
  setLicenseStatus,
  deleteLicense,
  deleteOwnerAndStores,
  addProduct,
  getProduct,
  getProductsByGuild,
  updateProduct,
  deleteProduct,
  createCoupon,
  applyCoupon,
  createOrder,
  createRenewalOrder,
  getOrderByCode,
  saveMercadoPagoConnection,
  getMercadoPagoConnection,
  getMercadoPagoConnectionByUserId,
  getMercadoPagoConnectionStatus,
  deleteMercadoPagoConnection,
  updateOrderMercadoPagoPreference,
  markOrderMercadoPagoPayment,
  getOrdersByGuild,
  getOrdersByCustomer,
  approveOrderAndCreateHosting,
  refundOrder,
  getHostingByCode,
  getHostingsByCustomer,
  getHostingsByGuild,
  getAllHostings,
  renewHosting,
  transferHostingOwner,
  updateHostingStatus,
  deleteHosting,
  registerFixedPanel,
  getAllFixedPanels,
  removeFixedPanel,
  wasNotified,
  markNotified,
  getClientFullHistory,
  getGlobalMetrics,
  exportFullBackup
};
