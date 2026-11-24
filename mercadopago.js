'use strict';

const crypto = require('node:crypto');

function getEncryptionKey() {
  const raw = String(process.env.MP_TOKEN_ENCRYPTION_KEY || '').trim();
  if (!raw) throw new Error('MP_TOKEN_ENCRYPTION_KEY não configurada.');
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MP_TOKEN_ENCRYPTION_KEY deve representar exatamente 32 bytes (64 caracteres hex ou Base64).');
  return key;
}

function encryptToken(value) {
  if (typeof value !== 'string' || !value) throw new Error('Token Mercado Pago ausente.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptToken(payload) {
  const parts = String(payload || '').split('.');
  if (parts.length !== 3) throw new Error('Credencial Mercado Pago armazenada em formato inválido.');
  const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) throw new Error('Credencial Mercado Pago armazenada em formato inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function getOAuthConfig() {
  const clientId = String(process.env.MP_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.MP_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.MP_REDIRECT_URI || '').trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Configure MP_CLIENT_ID, MP_CLIENT_SECRET e MP_REDIRECT_URI.');
  }
  const parsed = new URL(redirectUri);
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('MP_REDIRECT_URI deve usar HTTPS em produção.');
  }
  return { clientId, clientSecret, redirectUri };
}

function createPkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function buildAuthorizationUrl({ state, challenge }) {
  const { clientId, redirectUri } = getOAuthConfig();
  const url = new URL('https://auth.mercadopago.com/authorization');
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    platform_id: 'mp',
    redirect_uri: redirectUri,
    state: String(state),
    code_challenge: String(challenge),
    code_challenge_method: 'S256',
    scope: 'offline_access'
  }).toString();
  return url.toString();
}

async function exchangeAuthorizationCode(code, verifier) {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  const response = await fetch('https://api.mercadopago.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri,
      code_verifier: String(verifier)
    }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Mercado Pago não autorizou a conexão. Verifique a configuração OAuth da aplicação.');
    error.status = response.status;
    throw error;
  }
  if (!data.access_token || !data.refresh_token || !data.user_id) {
    throw new Error('Resposta OAuth do Mercado Pago incompleta.');
  }
  return {
    mpUserId: String(data.user_id),
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token),
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 0) * 1000
  };
}


const refreshInFlight = new Map();

function refreshSellerToken(connection, db) {
  const now = Date.now();
  if (Number(connection.expires_at) > now + 5 * 60 * 1000) {
    return Promise.resolve(decryptToken(connection.access_token_enc));
  }
  const key = String(connection.guild_id);
  if (refreshInFlight.has(key)) return refreshInFlight.get(key);

  const task = (async () => {
    const { clientId, clientSecret } = getOAuthConfig();
    const refreshToken = decryptToken(connection.refresh_token_enc);
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token || !data.refresh_token) {
      throw new Error('A conexão Mercado Pago expirou ou foi revogada. O lojista precisa conectar novamente.');
    }
    await db.saveMercadoPagoConnection({
      guildId: connection.guild_id,
      mpUserId: String(data.user_id || connection.mp_user_id),
      nickname: connection.nickname || '',
      accessTokenEnc: encryptToken(String(data.access_token)),
      refreshTokenEnc: encryptToken(String(data.refresh_token)),
      expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 0) * 1000
    });
    return String(data.access_token);
  })();
  refreshInFlight.set(key, task);
  return task.finally(() => refreshInFlight.delete(key));
}

async function createCheckoutPreference(order, db) {
  if (order.mp_preference_id && order.payment_url) {
    return { preferenceId: String(order.mp_preference_id), paymentUrl: String(order.payment_url) };
  }
  const connection = await db.getMercadoPagoConnection(order.guild_id);
  if (!connection) throw new Error('Esta loja ainda não conectou uma conta Mercado Pago.');
  const claimed = await db.claimMercadoPagoCheckout(order.order_code);
  if (!claimed) {
    const latest = await db.getOrderByCode(order.order_code);
    if (latest?.mp_preference_id && latest?.payment_url) {
      return { preferenceId: String(latest.mp_preference_id), paymentUrl: String(latest.payment_url) };
    }
    throw new Error('O checkout deste pedido já está sendo criado ou não está mais pendente.');
  }
  try {
    const accessToken = await refreshSellerToken(connection, db);
    let baseUrl = String(process.env.PUBLIC_BASE_URL || '').trim();
    while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    if (!baseUrl) throw new Error('PUBLIC_BASE_URL não configurada.');
    const parsedBase = new URL(baseUrl);
    if (process.env.NODE_ENV === 'production' && parsedBase.protocol !== 'https:') {
      throw new Error('PUBLIC_BASE_URL deve usar HTTPS em produção.');
    }
    const amount = Number(order.final_price);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Valor do pedido inválido.');
    const payload = {
      items: [{
        id: String(order.product_id || order.order_code),
        title: String(order.plan_name || 'Produto').slice(0, 250),
        quantity: 1,
        currency_id: 'BRL',
        unit_price: Number(amount.toFixed(2))
      }],
      external_reference: String(order.order_code),
      notification_url: baseUrl + '/webhooks/mercadopago',
      back_urls: {
        success: baseUrl + '/payment/result?status=success',
        pending: baseUrl + '/payment/result?status=pending',
        failure: baseUrl + '/payment/result?status=failure'
      },
      auto_return: 'approved',
      metadata: { guild_id: String(order.guild_id), order_code: String(order.order_code) }
    };
    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id || !data.init_point) {
      throw new Error('Mercado Pago não conseguiu criar o checkout para esta loja.');
    }
    const saved = await db.updateOrderMercadoPagoPreference(order.order_code, {
      preferenceId: data.id,
      paymentUrl: data.init_point
    });
    if (!saved) throw new Error('O pedido deixou de estar pendente antes de salvar o checkout.');
    return { preferenceId: String(data.id), paymentUrl: String(data.init_point) };
  } catch (err) {
    await db.failMercadoPagoCheckout(order.order_code).catch(() => {});
    throw err;
  }
}

async function fetchPayment(paymentId, accessToken) {
  const response = await fetch('https://api.mercadopago.com/v1/payments/' + encodeURIComponent(String(paymentId)), {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new Error('Não foi possível consultar o pagamento no Mercado Pago.');
  return data;
}

async function fetchSellerProfile(accessToken) {
  const response = await fetch('https://api.mercadopago.com/users/me', {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  return { nickname: String(data.nickname || data.first_name || '').slice(0, 100) };
}

function verifyWebhookSignature({ signature, requestId, dataId, secret }) {
  if (!signature || !requestId || !dataId || !secret) return false;
  const fields = Object.fromEntries(String(signature).split(',').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }));
  const ts = fields.ts;
  const received = fields.v1;
  if (!/^\\d+$/.test(ts || '') || !/^[a-f0-9]{64}$/i.test(received || '')) return false;
  const manifest = 'id:' + String(dataId).toLowerCase() + ';request-id:' + String(requestId) + ';ts:' + ts + ';';
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest();
  const supplied = Buffer.from(received, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

module.exports = {
  encryptToken,
  decryptToken,
  getOAuthConfig,
  createPkcePair,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchSellerProfile,
  refreshSellerToken,
  createCheckoutPreference,
  fetchPayment,
  verifyWebhookSignature
};
