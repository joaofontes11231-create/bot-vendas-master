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
  verifyWebhookSignature
};
