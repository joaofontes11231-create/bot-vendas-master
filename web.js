const express = require('express');
const session = require('express-session');
const crypto = require('node:crypto');
const db = require('./database');
const mp = require('./mercadopago');
const { client: discordClient, notifyLicenseActivated, notifyLicenseBlocked, notifyOrderApproved, refreshAllFixedPanels } = require('./bot');

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));

// A generated fallback prevents a known/default secret; configure SESSION_SECRET
// in production to keep sessions valid across restarts.
const sessionSecret = process.env.SESSION_SECRET?.trim() || crypto.randomBytes(48).toString('hex');
if (!process.env.SESSION_SECRET?.trim()) {
  console.warn('⚠️ SESSION_SECRET não definido: sessões serão invalidadas quando o processo reiniciar.');
}

app.use(
  session({
    name: 'hosting.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    }
  })
);

// Proteção simples contra submissões cross-site em rotas que alteram dados.
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return res.status(403).json({ ok: false, error: 'Origem não permitida.' });
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ ok: false, error: 'Origem não permitida.' });
      }
    } catch {
      return res.status(403).json({ ok: false, error: 'Origem inválida.' });
    }
  }
  return next();
});

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function getLoginAttempt(ip) {
  const now = Date.now();
  if (loginAttempts.size > 5000) {
    for (const [key, value] of loginAttempts) {
      if (value.resetAt <= now) loginAttempts.delete(key);
    }
    while (loginAttempts.size > 5000) {
      const oldestKey = loginAttempts.keys().next().value;
      if (oldestKey === undefined) break;
      loginAttempts.delete(oldestKey);
    }
  }
  const current = loginAttempts.get(ip);
  if (!current || current.resetAt <= now) {
    const next = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(ip, next);
    return next;
  }
  return current;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Autenticação necessária.' });
  }
  return res.redirect('/login');
}

function groupByOwner(licenses) {
  const map = new Map();
  for (const lic of licenses) {
    if (!map.has(lic.owner_id)) {
      map.set(lic.owner_id, { owner_id: lic.owner_id, stores: [], activeStores: 0 });
    }
    const g = map.get(lic.owner_id);
    g.stores.push(lic);
    if (lic.isOperational) g.activeStores += 1;
  }
  return Array.from(map.values());
}

const STYLES = `
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; width: 100%; min-height: 100vh;
    background: #0b1120; color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    font-size: 16px; line-height: 1.45; overflow-x: hidden;
  }
  .page { width: 100%; min-height: 100vh; padding: 16px; }
  @media (min-width: 768px) { .page { padding: 26px 36px; } }
  header {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; flex-wrap: wrap; margin-bottom: 20px; padding-bottom: 14px;
    border-bottom: 1px solid #1e293b;
  }
  h1 { margin: 0; font-size: 22px; }
  h2 { margin: 0 0 12px 0; font-size: 18px; }
  .stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px; margin-bottom: 20px;
  }
  .stat-card {
    background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 14px;
  }
  .stat-val { font-size: 22px; font-weight: 800; color: #38bdf8; }
  .layout {
    display: grid; grid-template-columns: 1fr; gap: 18px; width: 100%;
  }
  @media (min-width: 980px) { .layout { grid-template-columns: 390px 1fr; } }
  .card {
    background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 18px; width: 100%;
  }
  label { display: block; font-size: 14px; font-weight: 600; color: #cbd5e1; margin-bottom: 6px; }
  input, select {
    width: 100%; padding: 11px 12px; font-size: 16px; border-radius: 10px;
    border: 1px solid #475569; background: #0f172a; color: #fff; margin-bottom: 12px;
  }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 10px 15px; font-size: 14px; font-weight: 700; border: none;
    border-radius: 10px; cursor: pointer; text-decoration: none; color: #fff; background: #2563eb;
  }
  .btn-success { background: #16a34a; }
  .btn-danger { background: #dc2626; }
  .btn-secondary { background: #334155; }
  .btn-block { width: 100%; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .item-box {
    background: #0f172a; border: 1px solid #334155; border-radius: 12px;
    padding: 14px; margin-bottom: 12px; word-break: break-word;
  }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
  .badge-on { background: rgba(22, 163, 74, .2); color: #4ade80; }
  .badge-off { background: rgba(239, 68, 68, .2); color: #f87171; }
  .muted { color: #94a3b8; font-size: 14px; }
  code { background: #1e293b; padding: 2px 6px; border-radius: 6px; font-size: 13px; }
  #toast {
    position: fixed; bottom: 18px; right: 18px; left: 18px; max-width: 420px; margin-left: auto;
    background: #16a34a; color: #fff; padding: 12px 16px; border-radius: 10px; font-weight: 700;
    display: none; z-index: 99; box-shadow: 0 8px 20px rgba(0,0,0,.4);
  }
`;

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'web', timestamp: new Date().toISOString() });
});

app.get('/status', async (req, res) => {
  const m = await db.getGlobalMetrics();
  const botStatus = discordClient.isReady() ? 'ONLINE' : 'OFFLINE';
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Status & Informações — Pacote Pro</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page" style="max-width: 960px; margin: 0 auto;">
    <header>
      <div>
        <h1>Status da Infraestrutura</h1>
        <div class="muted">Monitoramento 24 horas sincronizado com o Discord</div>
      </div>
      <div class="actions" style="margin-top:0;">
        <a class="btn btn-secondary" href="/termos">Termos & FAQ</a>
        <a class="btn" href="/login">Área Administrativa</a>
      </div>
    </header>
    <div class="stats">
      <div class="stat-card"><div class="muted">Bot Discord</div><div class="stat-val" style="color:${botStatus === 'ONLINE' ? '#4ade80' : '#f87171'};">${botStatus}</div></div>
      <div class="stat-card"><div class="muted">Banco Central</div><div class="stat-val" style="color:#4ade80;">ONLINE (consulta OK)</div></div>
      <div class="stat-card"><div class="muted">Hospedagens Ativas</div><div class="stat-val">${m.activeHostings}</div></div>
      <div class="stat-card"><div class="muted">Avaliação Média</div><div class="stat-val">${m.avgRating}★</div></div>
    </div>
  </div>
</body>
</html>`);
});

app.get('/termos', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Termos de Serviço & FAQ</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page" style="max-width: 900px; margin: 0 auto;">
    <header>
      <h1>Termos de Serviço & FAQ</h1>
      <a class="btn btn-secondary" href="/status">Voltar ao Status</a>
    </header>
    <div class="card" style="margin-bottom:16px;">
      <h2>Avisos de Vencimento</h2>
      <div class="muted">O sistema notifica automaticamente 7 dias, 3 dias e 1 dia antes do vencimento, suspendendo serviços vencidos até a confirmação da renovação.</div>
    </div>
    <div class="card">
      <h2>Pagamentos e Liberação</h2>
      <div class="muted">Pedidos gerados via PIX são conferidos e liberados pela equipe administrativa, registrando código único e histórico completo.</div>
    </div>
  </div>
</body>
</html>`);
});

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login — Central Administrativa Pro</title>
  <style>
    ${STYLES}
    .center-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .login-card { width: 100%; max-width: 400px; }
  </style>
</head>
<body>
  <div class="center-wrap">
    <div class="card login-card">
      <h2>Central Administrativa Pro</h2>
      ${req.query.error ? '<div style="color:#f87171;margin-bottom:10px;">Senha incorreta.</div>' : ''}
      <form method="POST" action="/login">
        <label>Senha Master</label>
        <input type="password" name="password" required autofocus />
        <button class="btn btn-block" type="submit">Entrar</button>
      </form>
      <div style="margin-top:12px;text-align:center;"><a href="/status" class="muted">Ver Status Público</a></div>
    </div>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const attempts = getLoginAttempt(ip);
  if (attempts.count >= LOGIN_MAX_ATTEMPTS) {
    const retrySeconds = Math.max(1, Math.ceil((attempts.resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retrySeconds));
    return res.status(429).send('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
  }

  const masterPass = process.env.MASTER_PASSWORD || '';
  const inputPass = typeof req.body.password === 'string' ? req.body.password : '';
  const expected = Buffer.from(masterPass, 'utf8');
  const supplied = Buffer.from(inputPass, 'utf8');
  const passwordMatches = expected.length > 0 &&
    expected.length === supplied.length &&
    crypto.timingSafeEqual(expected, supplied);

  if (!passwordMatches) {
    attempts.count += 1;
    return res.redirect('/login?error=1');
  }

  loginAttempts.delete(ip);
  return req.session.regenerate((err) => {
    if (err) return res.status(500).send('Não foi possível iniciar a sessão.');
    req.session.authenticated = true;
    return req.session.save((saveErr) => {
      if (saveErr) return res.status(500).send('Não foi possível salvar a sessão.');
      return res.redirect('/');
    });
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

function isDiscordId(value) {
  return /^\\d{17,20}$/.test(String(value || ''));
}

function safeStateEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function getOwnedStore(req, res) {
  const guildId = String(req.params.guildId || '');
  if (!isDiscordId(guildId)) {
    res.status(400).send('Identificador de loja inválido.');
    return null;
  }
  const license = await db.getLicense(guildId);
  if (!license) {
    res.status(404).send('Loja não encontrada.');
    return null;
  }
  if (!req.session?.sellerDiscordId || String(req.session.sellerDiscordId) !== String(license.owner_id)) {
    res.status(403).send('Esta conta Discord não é proprietária desta loja.');
    return null;
  }
  return license;
}

app.get('/auth/discord', (req, res) => {
  const guildId = String(req.query.guild_id || '');
  if (!isDiscordId(guildId)) return res.status(400).send('Loja inválida.');
  const clientId = String(process.env.CLIENT_ID || '').trim();
  const redirectUri = String(process.env.DISCORD_REDIRECT_URI || '').trim();
  if (!clientId || !process.env.DISCORD_CLIENT_SECRET || !redirectUri) {
    return res.status(503).send('Login Discord ainda não configurado pelo administrador.');
  }
  const state = crypto.randomBytes(32).toString('hex');
  req.session.discordOAuth = { state, guildId, createdAt: Date.now() };
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'identify',
    state
  }).toString();
  return req.session.save((err) => {
    if (err) return res.status(500).send('Não foi possível iniciar o login Discord.');
    return res.redirect(url.toString());
  });
});

app.get('/auth/discord/callback', async (req, res) => {
  try {
    const pending = req.session?.discordOAuth;
    if (!pending || Date.now() - Number(pending.createdAt) > 10 * 60 * 1000 ||
        !safeStateEqual(pending.state, req.query.state) || !req.query.code) {
      return res.status(400).send('Login Discord expirado ou inválido. Inicie novamente.');
    }
    const redirectUri = String(process.env.DISCORD_REDIRECT_URI || '').trim();
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: String(process.env.CLIENT_ID || ''),
        client_secret: String(process.env.DISCORD_CLIENT_SECRET || ''),
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: redirectUri
      }),
      signal: AbortSignal.timeout(15000)
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(401).send('Não foi possível autenticar no Discord.');
    }
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    const user = await userResponse.json().catch(() => ({}));
    if (!userResponse.ok || !isDiscordId(user.id)) {
      return res.status(401).send('Não foi possível validar a conta Discord.');
    }
    const guildId = pending.guildId;
    req.session.discordOAuth = null;
    req.session.sellerDiscordId = String(user.id);
    req.session.sellerDiscordName = String(user.username || '').slice(0, 80);
    return req.session.save((err) => {
      if (err) return res.status(500).send('Não foi possível salvar a sessão.');
      return res.redirect('/seller/' + encodeURIComponent(guildId));
    });
  } catch (err) {
    console.error('Falha no login Discord do lojista:', err.message);
    return res.status(502).send('Falha ao autenticar no Discord. Tente novamente.');
  }
});

app.get('/seller/:guildId', async (req, res) => {
  try {
    if (!req.session?.sellerDiscordId) {
      return res.redirect('/auth/discord?guild_id=' + encodeURIComponent(req.params.guildId));
    }
    const license = await getOwnedStore(req, res);
    if (!license) return;
    const connection = await db.getMercadoPagoConnectionStatus(license.guild_id);
    const connected = Boolean(connection);
    const nickname = connection?.nickname ? String(connection.nickname).replace(/[&<>"']/g, '') : '';
    return res.send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagamentos da loja</title><style>
body{margin:0;background:#0b1120;color:#f8fafc;font:16px Arial,sans-serif;padding:24px}
main{max-width:680px;margin:30px auto;background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px}
p{color:#cbd5e1;line-height:1.6}.status{padding:12px;border-radius:10px;background:#0f172a;margin:16px 0}
a,button{display:inline-block;padding:12px 16px;border-radius:9px;text-decoration:none;border:0;background:#16a34a;color:white;font-weight:bold}
small{color:#94a3b8}
</style></head><body><main>
<h1>Pagamentos — ${String(license.store_name).replace(/[&<>"']/g, '')}</h1>
<p>Conecte a conta Mercado Pago pertencente ao responsável por esta loja. A autorização é feita no próprio Mercado Pago; sua senha não é compartilhada com este sistema.</p>
<div class="status">${connected ? '🟢 Conta conectada' + (nickname ? ' — ' + nickname : '') : '🟠 Nenhuma conta Mercado Pago conectada'}</div>
<a href="/seller/${encodeURIComponent(license.guild_id)}/mercadopago/connect">${connected ? 'Reconectar Mercado Pago' : 'Conectar Mercado Pago'}</a>
<p><small>O token de acesso fica criptografado no banco. Nunca envie tokens, senhas ou códigos de autorização por mensagens.</small></p>
</main></body></html>`);
  } catch (err) {
    console.error('Erro ao abrir painel do lojista:', err.message);
    return res.status(500).send('Não foi possível carregar o painel da loja.');
  }
});

app.get('/seller/:guildId/mercadopago/connect', async (req, res) => {
  try {
    if (!req.session?.sellerDiscordId) {
      return res.redirect('/auth/discord?guild_id=' + encodeURIComponent(req.params.guildId));
    }
    const license = await getOwnedStore(req, res);
    if (!license) return;
    const { verifier, challenge } = mp.createPkcePair();
    const state = crypto.randomBytes(32).toString('hex');
    req.session.mpOAuth = {
      state,
      verifier,
      guildId: String(license.guild_id),
      sellerDiscordId: String(req.session.sellerDiscordId),
      createdAt: Date.now()
    };
    const authorizationUrl = mp.buildAuthorizationUrl({ state, challenge });
    return req.session.save((err) => {
      if (err) return res.status(500).send('Não foi possível iniciar a conexão Mercado Pago.');
      return res.redirect(authorizationUrl);
    });
  } catch (err) {
    console.error('Erro ao iniciar OAuth Mercado Pago:', err.message);
    return res.status(503).send('Integração Mercado Pago ainda não configurada pelo administrador.');
  }
});

app.get('/oauth/mercadopago/callback', async (req, res) => {
  try {
    const pending = req.session?.mpOAuth;
    if (!pending || Date.now() - Number(pending.createdAt) > 10 * 60 * 1000 ||
        !safeStateEqual(pending.state, req.query.state) || !req.query.code) {
      return res.status(400).send('Autorização Mercado Pago expirada ou inválida. Inicie novamente.');
    }
    if (!req.session?.sellerDiscordId ||
        String(req.session.sellerDiscordId) !== String(pending.sellerDiscordId)) {
      return res.status(403).send('Sessão do lojista não corresponde à autorização iniciada.');
    }
    const license = await db.getLicense(pending.guildId);
    if (!license || String(license.owner_id) !== String(pending.sellerDiscordId)) {
      return res.status(403).send('A conta Discord não é mais proprietária desta loja.');
    }
    const tokens = await mp.exchangeAuthorizationCode(String(req.query.code), pending.verifier);
    const profile = await mp.fetchSellerProfile(tokens.accessToken);
    await db.saveMercadoPagoConnection({
      guildId: license.guild_id,
      mpUserId: tokens.mpUserId,
      nickname: profile?.nickname || '',
      accessTokenEnc: mp.encryptToken(tokens.accessToken),
      refreshTokenEnc: mp.encryptToken(tokens.refreshToken),
      expiresAt: tokens.expiresAt
    });
    req.session.mpOAuth = null;
    await new Promise((resolve, reject) => req.session.save((err) => err ? reject(err) : resolve()));
    return res.redirect('/seller/' + encodeURIComponent(license.guild_id) + '?connected=1');
  } catch (err) {
    console.error('Falha na conexão Mercado Pago:', err.message);
    return res.status(502).send('Não foi possível concluir a conexão Mercado Pago. Verifique a configuração OAuth e tente novamente.');
  }
});

app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const metrics = await db.getGlobalMetrics();
    const clients = groupByOwner(metrics.licenses);
    res.json({ ok: true, metrics, clients });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Erro ao carregar estado.' });
  }
});

app.get('/api/backup', requireAuth, async (req, res) => {
  try {
    const data = await db.exportFullBackup();
    res.setHeader('Content-Disposition', 'attachment; filename="backup-sistema-pro.json"');
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Erro ao gerar backup.' });
  }
});

app.get('/api/clients/:ownerId', requireAuth, async (req, res) => {
  try {
    const ownerId = String(req.params.ownerId).trim();
    const stores = await db.getClientFullHistory(ownerId);
    res.json({ ok: true, owner_id: ownerId, stores });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Erro ao carregar ficha.' });
  }
});

app.post('/api/licenses', requireAuth, async (req, res) => {
  try {
    const { guild_id, owner_id, store_name, server_name, days } = req.body;
    const dayCount = Number(days);
    const snowflake = /^\d{17,20}$/;
    if (!snowflake.test(String(guild_id || '')) || !snowflake.test(String(owner_id || ''))) {
      return res.status(400).json({ ok: false, error: 'Informe IDs válidos do Discord para servidor e proprietário.' });
    }
    if (typeof store_name !== 'string' || !store_name.trim() || store_name.trim().length > 80) {
      return res.status(400).json({ ok: false, error: 'O nome da loja é obrigatório e deve ter até 80 caracteres.' });
    }
    if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 3650) {
      return res.status(400).json({ ok: false, error: 'A duração deve ser um número inteiro entre 1 e 3650 dias.' });
    }
    const lic = await db.upsertLicense(guild_id, owner_id, store_name.trim(), dayCount, server_name || null);
    await db.logAudit(guild_id, 'WEB_MASTER', 'ATIVAR_LICENCA', `${store_name} (${days}d)`);
    notifyLicenseActivated(lic).catch(() => {});
    refreshAllFixedPanels().catch(() => {});
    const metrics = await db.getGlobalMetrics();
    res.json({ ok: true, license: lic, metrics, clients: groupByOwner(metrics.licenses) });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Erro ao salvar.' });
  }
});

app.patch('/api/licenses/:guildId', requireAuth, async (req, res) => {
  try {
    const prev = await db.getLicense(req.params.guildId);
    const { owner_id, store_name, server_name, days, active, pix_key, maintenance, block_reason } = req.body;
    const updated = await db.updateLicenseDetails(req.params.guildId, {
      ownerId: owner_id,
      storeName: store_name,
      serverName: server_name,
      days: days !== undefined && days !== '' ? Number(days) : undefined,
      active: typeof active === 'boolean' ? active : undefined,
      pixKey: pix_key !== undefined ? pix_key : undefined,
      maintenance: typeof maintenance === 'boolean' ? maintenance : undefined,
      blockReason: block_reason
    });
    if (!updated) return res.status(404).json({ ok: false, error: 'Loja não encontrada.' });

    if (prev && prev.active && updated.active === false) {
      notifyLicenseBlocked(updated, block_reason).catch(() => {});
    } else if (prev && !prev.active && updated.active === true && updated.isOperational) {
      notifyLicenseActivated(updated).catch(() => {});
    }

    await db.logAudit(req.params.guildId, 'WEB_MASTER', 'EDITAR_LOJA', updated.store_name);
    refreshAllFixedPanels().catch(() => {});
    const metrics = await db.getGlobalMetrics();
    res.json({ ok: true, license: updated, metrics, clients: groupByOwner(metrics.licenses) });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Erro ao atualizar.' });
  }
});

app.post('/api/orders/:orderCode/approve', requireAuth, async (req, res) => {
  try {
    const orderCode = String(req.params.orderCode || '').trim().toUpperCase();
    if (!/^PED-[A-Z0-9-]{1,32}$/.test(orderCode)) {
      return res.status(400).json({ ok: false, error: 'Código de pedido inválido.' });
    }
    const current = await db.getOrderByCode(orderCode);
    if (!current) return res.status(404).json({ ok: false, error: 'Pedido não encontrado.' });
    if (current.status !== 'pending') {
      return res.status(409).json({ ok: false, error: 'O pedido não está pendente ou já foi processado.' });
    }

    const { access_info } = req.body;
    const result = await db.approveOrderAndCreateHosting(orderCode, access_info || 'Liberado via Painel Web');
    if (!result) return res.status(409).json({ ok: false, error: 'Não foi possível aprovar. Atualize o pedido e confira o status.' });
    if (result.alreadyApproved) {
      return res.status(409).json({ ok: false, error: 'Este pedido já foi aprovado.' });
    }
    await db.logAudit(result.order.guild_id, 'WEB_MASTER', 'APROVAR_PEDIDO', `${result.order.order_code} -> ${result.hosting.code}`);
    const license = await db.getLicense(result.order.guild_id);
    await notifyOrderApproved(result, license?.store_name || 'Hospedagem');
    refreshAllFixedPanels().catch(() => {});
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Erro ao aprovar pedido pelo painel web:', err);
    res.status(500).json({ ok: false, error: 'Erro ao aprovar pedido.' });
  }
});

app.delete('/api/licenses/:guildId', requireAuth, async (req, res) => {
  try {
    const ok = await db.deleteLicense(req.params.guildId);
    if (!ok) return res.status(404).json({ ok: false, error: 'Não encontrada.' });
    refreshAllFixedPanels().catch(() => {});
    const metrics = await db.getGlobalMetrics();
    res.json({ ok: true, metrics, clients: groupByOwner(metrics.licenses) });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Erro ao remover.' });
  }
});

app.delete('/api/clients/:ownerId', requireAuth, async (req, res) => {
  try {
    const count = await db.deleteOwnerAndStores(req.params.ownerId);
    if (!count) return res.status(404).json({ ok: false, error: 'Cliente não encontrado.' });
    refreshAllFixedPanels().catch(() => {});
    const metrics = await db.getGlobalMetrics();
    res.json({ ok: true, metrics, clients: groupByOwner(metrics.licenses) });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Erro ao remover cliente.' });
  }
});

// PAINEL MASTER PRINCIPAL (ATUALIZAÇÃO INSTANTÂNEA SEM RECARREGAR)
app.get('/', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0" />
  <title>Central Administrativa Pro</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <header>
      <div>
        <h1>Central Administrativa — Pacote Pro</h1>
        <div class="muted">Atualização instantânea • Sincronizado 24h com Discord e Painéis Fixos</div>
      </div>
      <div class="actions" style="margin-top:0;">
        <a class="btn btn-secondary" href="/api/backup">Baixar Backup JSON</a>
        <a class="btn btn-secondary" href="/status" target="_blank">Status Público</a>
        <form method="POST" action="/logout"><button class="btn btn-danger" type="submit">Sair</button></form>
      </div>
    </header>

    <div class="stats" id="statsBar"></div>

    <div class="layout">
      <div>
        <div class="card" style="margin-bottom:18px;">
          <h2>Ativar / Adicionar Empresa</h2>
          <form id="createForm">
            <label>ID do Dono (Cliente no Discord)</label>
            <input type="text" name="owner_id" required placeholder="Ex: 123456789012345678" />
            <label>ID do Servidor (Empresa)</label>
            <input type="text" name="guild_id" required placeholder="Ex: 987654321098765432" />
            <label>Nome do Servidor (Exibido na DM)</label>
            <input type="text" name="server_name" placeholder="Ex: Comunidade GV Host" />
            <label>Nome da Empresa / Loja</label>
            <input type="text" name="store_name" required placeholder="Ex: GV Host" />
            <label>Dias de Licença</label>
            <input type="number" name="days" min="1" value="30" required />
            <button id="createBtn" class="btn btn-success btn-block" type="submit">Ativar e Atualizar na Hora</button>
          </form>
        </div>

        <div class="card">
          <h2>Pedidos PIX Pendentes (<span id="pendingCount">0</span>)</h2>
          <div id="pendingOrdersList"><div class="muted">Carregando...</div></div>
        </div>
      </div>

      <div class="card">
        <h2>Clientes (Donos) Cadastrados (<span id="clientCount">0</span>)</h2>
        <div id="clientsList"><div class="muted">Carregando...</div></div>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    let state = { metrics: {}, clients: [] };

    function showToast(msg, isError = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.background = isError ? '#dc2626' : '#16a34a';
      el.style.display = 'block';
      clearTimeout(window._t);
      window._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
    }

    function computeClientsFromLicenses(licenses) {
      const map = new Map();
      for (const lic of licenses) {
        if (!map.has(lic.owner_id)) {
          map.set(lic.owner_id, { owner_id: lic.owner_id, stores: [], activeStores: 0 });
        }
        const g = map.get(lic.owner_id);
        g.stores.push(lic);
        if (lic.isOperational) g.activeStores += 1;
      }
      return Array.from(map.values());
    }

    async function loadState() {
      const res = await fetch('/api/state', { cache: 'no-store' });
      const data = await res.json();
      if (data.ok) {
        state = data;
        renderAll();
      }
    }

    function renderAll() {
      const m = state.metrics || {};
      document.getElementById('statsBar').innerHTML = \`
        <div class="stat-card"><div class="muted">Clientes</div><div class="stat-val">\${m.totalClients || 0}</div></div>
        <div class="stat-card"><div class="muted">Lojas Ativas</div><div class="stat-val">\${m.activeStores || 0}/\${m.totalStores || 0}</div></div>
        <div class="stat-card"><div class="muted">Hospedagens Ativas</div><div class="stat-val">\${m.activeHostings || 0}</div></div>
        <div class="stat-card"><div class="muted">Vendas Aprovadas</div><div class="stat-val">R$ \${Number(m.totalRevenue || 0).toFixed(2)}</div></div>
      \`;

      const pending = (m.orders || []).filter(o => o.status === 'pending');
      document.getElementById('pendingCount').textContent = pending.length;
      document.getElementById('pendingOrdersList').innerHTML = pending.length
        ? pending.map(o => \`
            <div class="item-box">
              <div><strong>\${o.order_code}</strong> — \${escapeHtml(o.plan_name)}</div>
              <div class="muted">Cliente: <code>\${o.customer_id}</code> • R$ \${Number(o.final_price).toFixed(2)}</div>
              <div class="actions">
                <button class="btn btn-success" type="button" onclick="approveOrder('\${o.order_code}')">Confirmar PIX & Liberar</button>
              </div>
            </div>
          \`).join('')
        : '<div class="muted">Nenhum pedido aguardando PIX.</div>';

      document.getElementById('clientCount').textContent = state.clients.length;
      document.getElementById('clientsList').innerHTML = state.clients.length
        ? state.clients.map(c => {
            const badges = c.stores.map(s =>
              \`<span class="badge \${s.isOperational ? 'badge-on' : 'badge-off'}" style="margin-right:6px;margin-top:4px;">\${escapeHtml(s.store_name)} • \${escapeHtml(s.server_name)} (\${s.daysLeft}d)</span>\`
            ).join('');
            return \`
              <div class="item-box">
                <div><strong>Cliente ID:</strong> <code>\${c.owner_id}</code></div>
                <div class="muted">Lojas: <strong>\${c.stores.length}</strong> • Ativas: <strong>\${c.activeStores}</strong></div>
                <div style="margin-top:6px;">\${badges}</div>
                <div class="actions">
                  <a class="btn" href="/cliente/\${encodeURIComponent(c.owner_id)}" target="_blank" rel="noopener">Editar / Ver Tudo (Nova Aba)</a>
                  <button class="btn btn-danger" type="button" onclick="removeClient('\${c.owner_id}')">Remover Cliente</button>
                </div>
              </div>
            \`;
          }).join('')
        : '<div class="muted">Nenhum cliente cadastrado.</div>';
    }

    async function approveOrder(orderCode) {
      const access = prompt('Dados de acesso da hospedagem para enviar ao cliente:', 'Painel ativo — detalhes no suporte');
      if (access === null) return;
      const res = await fetch('/api/orders/' + encodeURIComponent(orderCode) + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_info: access })
      });
      const data = await res.json();
      if (data.ok) {
        if (state.metrics?.orders) {
          state.metrics.orders = state.metrics.orders.map(o => o.order_code === orderCode ? { ...o, status: 'approved' } : o);
          state.metrics.activeHostings = Number(state.metrics.activeHostings || 0) + 1;
          renderAll();
        }
        showToast('Pedido aprovado e hospedagem ativada!');
      } else {
        showToast(data.error || 'Erro ao aprovar', true);
      }
    }

    async function removeClient(ownerId) {
      if (!confirm('Remover este cliente e TODAS as lojas/hospedagens dele?')) return;
      const res = await fetch('/api/clients/' + encodeURIComponent(ownerId), { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        state.metrics = data.metrics || state.metrics;
        state.clients = data.clients || state.clients.filter(c => c.owner_id !== ownerId);
        renderAll();
        showToast('Cliente removido na hora!');
      }
    }

    document.getElementById('createForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('createBtn');
      btn.disabled = true;
      const payload = Object.fromEntries(new FormData(e.target).entries());

      try {
        const res = await fetch('/api/licenses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.ok) {
          // Atualiza imediatamente na tela sem esperar recarregar
          if (data.metrics) state.metrics = data.metrics;
          if (data.clients) {
            state.clients = data.clients;
          } else if (data.license) {
            const currentLics = (state.metrics?.licenses || []).filter(l => l.guild_id !== data.license.guild_id);
            currentLics.unshift(data.license);
            state.metrics.licenses = currentLics;
            state.clients = computeClientsFromLicenses(currentLics);
          }
          e.target.reset();
          e.target.days.value = 30;
          renderAll();
          showToast('Adicionado e atualizado na hora!');
        } else {
          showToast(data.error || 'Erro ao ativar', true);
        }
      } finally {
        btn.disabled = false;
      }
    });

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    }

    loadState();
  </script>
</body>
</html>`);
});

// NOVA ABA DO CLIENTE COM TUDO QUE ELE FEZ + MOTIVO DE BLOQUEIO + NOME DO SERVIDOR
app.get('/cliente/:ownerId', requireAuth, (req, res) => {
  const ownerId = String(req.params.ownerId).trim();
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0" />
  <title>Ficha Completa — ${ownerId}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="page">
    <header>
      <div>
        <h1>Ficha Completa do Cliente</h1>
        <div class="muted">ID Discord: <code>${ownerId}</code></div>
      </div>
      <div class="actions" style="margin-top:0;">
        <button class="btn btn-danger" type="button" onclick="deleteClient()">Remover Cliente</button>
        <button class="btn btn-secondary" type="button" onclick="window.close()">Fechar Aba</button>
      </div>
    </header>
    <div id="content"><div class="muted">Carregando tudo que o cliente fez...</div></div>
  </div>
  <div id="toast"></div>

  <script>
    const OWNER_ID = ${JSON.stringify(ownerId)};

    function showToast(msg, isError = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.background = isError ? '#dc2626' : '#16a34a';
      el.style.display = 'block';
      clearTimeout(window._t);
      window._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
    }

    async function loadData() {
      const res = await fetch('/api/clients/' + encodeURIComponent(OWNER_ID), { cache: 'no-store' });
      const data = await res.json();
      const box = document.getElementById('content');

      if (!data.ok || !data.stores.length) {
        box.innerHTML = '<div class="card"><div class="muted">Nenhuma loja vinculada a este cliente.</div></div>';
        return;
      }

      box.innerHTML = data.stores.map(s => {
        const prodsHtml = s.products.length
          ? s.products.map(p => \`<div class="item-box"><strong>Plano #\${p.id}</strong> — \${escapeHtml(p.name)} (R$ \${Number(p.price).toFixed(2)} / \${p.duration_days || 30}d)<div class="muted">\${escapeHtml(p.specs || p.description)}</div></div>\`).join('')
          : '<div class="muted">Nenhum plano criado.</div>';

        const hosHtml = s.hostings.length
          ? s.hostings.map(h => \`<div class="item-box"><strong>\${h.code}</strong> — \${escapeHtml(h.plan_name)} | Cliente: <code>\${h.customer_id}</code> | \${h.status} (\${h.daysLeft}d)</div>\`).join('')
          : '<div class="muted">Nenhuma hospedagem ativa.</div>';

        const ordHtml = s.orders.length
          ? s.orders.map(o => \`
              <div class="item-box">
                <strong>\${o.order_code}</strong> — \${escapeHtml(o.plan_name)} | R$ \${Number(o.final_price).toFixed(2)} | Status: <strong>\${o.status}</strong>
                \${o.status === 'pending' ? \`<div class="actions"><button class="btn btn-success" type="button" onclick="approveOrder('\${o.order_code}')">Confirmar PIX & Liberar</button></div>\` : ''}
              </div>
            \`).join('')
          : '<div class="muted">Nenhum pedido registrado.</div>';

        return \`
          <div class="card" style="margin-bottom:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
              <div>
                <h2 style="margin:0;">Empresa: \${escapeHtml(s.store_name)}</h2>
                <div class="muted">Servidor: <strong>\${escapeHtml(s.server_name)}</strong> (<code>\${s.guild_id}</code>)</div>
              </div>
              <span class="badge \${s.isOperational ? 'badge-on' : 'badge-off'}">\${s.isOperational ? 'Ativo (' + s.daysLeft + 'd)' : 'Bloqueado/Inativo'}</span>
            </div>

            \${s.block_reason ? \`<div class="item-box" style="border-color:#dc2626;"><strong>Motivo do bloqueio:</strong> \${escapeHtml(s.block_reason)}</div>\` : ''}

            <form onsubmit="saveStore(event, '\${s.guild_id}')">
              <label>ID do Dono</label>
              <input type="text" name="owner_id" value="\${escapeHtml(s.owner_id)}" required />
              <label>Nome do Servidor (Exibido na DM)</label>
              <input type="text" name="server_name" value="\${escapeHtml(s.server_name)}" required />
              <label>Nome da Empresa / Loja</label>
              <input type="text" name="store_name" value="\${escapeHtml(s.store_name)}" required />
              <label>Chave PIX da Empresa</label>
              <input type="text" name="pix_key" value="\${escapeHtml(s.pix_key || '')}" placeholder="CPF, E-mail ou Chave Aleatória" />
              <label>Dias Restantes</label>
              <input type="number" name="days" min="0" value="\${s.daysLeft}" required />
              <label>Status</label>
              <select name="active">
                <option value="true" \${s.active ? 'selected' : ''}>Ativo</option>
                <option value="false" \${!s.active ? 'selected' : ''}>Bloqueado</option>
              </select>
              <label>Motivo do Bloqueio (se bloquear, será enviado na DM)</label>
              <input type="text" name="block_reason" value="\${escapeHtml(s.block_reason || '')}" placeholder="Ex: Mensalidade em atraso ou violação dos termos" />
              <div class="actions">
                <button class="btn btn-success" type="submit">Salvar e Sincronizar Agora</button>
                <button class="btn btn-danger" type="button" onclick="removeStore('\${s.guild_id}')">Remover Empresa</button>
              </div>
            </form>

            <hr style="border:0;border-top:1px solid #334155;margin:18px 0;" />
            <h2>Planos Criados (\${s.products.length})</h2>
            \${prodsHtml}

            <hr style="border:0;border-top:1px solid #334155;margin:18px 0;" />
            <h2>Pedidos PIX (\${s.orders.length})</h2>
            \${ordHtml}

            <hr style="border:0;border-top:1px solid #334155;margin:18px 0;" />
            <h2>Hospedagens Contratadas (\${s.hostings.length})</h2>
            \${hosHtml}
          </div>
        \`;
      }).join('');
    }

    async function saveStore(e, guildId) {
      e.preventDefault();
      const f = e.target;
      const res = await fetch('/api/licenses/' + encodeURIComponent(guildId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner_id: f.owner_id.value.trim(),
          server_name: f.server_name.value.trim(),
          store_name: f.store_name.value.trim(),
          pix_key: f.pix_key.value.trim(),
          days: Number(f.days.value),
          active: f.active.value === 'true',
          block_reason: f.block_reason.value.trim()
        })
      });
      const data = await res.json();
      if (data.ok) {
        showToast('Atualizado no site e no bot!');
        loadData();
      } else {
        showToast(data.error || 'Erro ao salvar', true);
      }
    }

    async function approveOrder(code) {
      const access = prompt('Dados de acesso para enviar ao cliente:', 'Painel ativo — detalhes enviados');
      if (access === null) return;
      const res = await fetch('/api/orders/' + encodeURIComponent(code) + '/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_info: access })
      });
      const data = await res.json();
      if (data.ok) {
        showToast('Pedido aprovado!');
        loadData();
      }
    }

    async function removeStore(guildId) {
      if (!confirm('Remover esta empresa?')) return;
      const res = await fetch('/api/licenses/' + encodeURIComponent(guildId), { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        showToast('Empresa removida!');
        loadData();
      }
    }

    async function deleteClient() {
      if (!confirm('Remover este cliente e TODAS as empresas dele?')) return;
      const res = await fetch('/api/clients/' + encodeURIComponent(OWNER_ID), { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        showToast('Cliente removido!');
        setTimeout(() => { window.location.href = '/'; }, 800);
      }
    }

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    }

    loadData();
  </script>
</body>
</html>`);
});

function startWeb() {
  const port = Number(process.env.PORT) || 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT inválida: informe uma porta entre 1 e 65535.');
  }
  const masterPassword = process.env.MASTER_PASSWORD || '';
  const configuredSessionSecret = process.env.SESSION_SECRET?.trim() || '';
  if (!masterPassword) {
    throw new Error('MASTER_PASSWORD não configurada. Defina uma senha segura no ambiente.');
  }
  if (process.env.NODE_ENV === 'production') {
    if (masterPassword.length < 12) {
      throw new Error('Em produção, MASTER_PASSWORD deve ter pelo menos 12 caracteres.');
    }
    if (configuredSessionSecret.length < 32) {
      throw new Error('Em produção, SESSION_SECRET deve ter pelo menos 32 caracteres aleatórios.');
    }
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0');
    server.once('error', reject);
    server.once('listening', () => {
      console.log(`🌐 Site e Central Administrativa Pro online na porta ${port}`);
      resolve(server);
    });
  });
}

module.exports = { startWeb, app };
