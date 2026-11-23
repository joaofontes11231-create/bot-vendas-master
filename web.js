const express = require('express');
const session = require('express-session');
const db = require('./database');
const { notifyLicenseActivated } = require('./bot');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'segredo_painel_master_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 }
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.redirect('/login');
}

function groupByOwner(licenses) {
  const map = new Map();

  for (const lic of licenses) {
    const ownerId = lic.owner_id;
    if (!map.has(ownerId)) {
      map.set(ownerId, {
        owner_id: ownerId,
        stores: [],
        activeStores: 0
      });
    }
    const group = map.get(ownerId);
    group.stores.push(lic);
    if (lic.isOperational) group.activeStores += 1;
  }

  return Array.from(map.values());
}

const BASE_STYLES = `
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    min-height: 100vh;
    background: #0f172a;
    color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.45;
    overflow-x: hidden;
  }
  .page {
    width: 100%;
    min-height: 100vh;
    padding: 16px;
  }
  @media (min-width: 768px) {
    .page { padding: 28px 36px; }
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 20px;
    padding-bottom: 14px;
    border-bottom: 1px solid #1e293b;
  }
  h1 { margin: 0; font-size: 22px; }
  h2 { margin: 0 0 12px 0; font-size: 18px; }
  .layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: 18px;
    width: 100%;
  }
  @media (min-width: 960px) {
    .layout { grid-template-columns: 380px 1fr; }
  }
  .card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 14px;
    padding: 18px;
    width: 100%;
  }
  label {
    display: block;
    font-size: 14px;
    font-weight: 600;
    color: #cbd5e1;
    margin-bottom: 6px;
  }
  input, select {
    width: 100%;
    padding: 12px;
    font-size: 16px;
    border-radius: 10px;
    border: 1px solid #475569;
    background: #0f172a;
    color: #fff;
    margin-bottom: 14px;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 11px 16px;
    font-size: 15px;
    font-weight: 700;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    text-decoration: none;
    color: #fff;
    background: #2563eb;
  }
  .btn:active { transform: scale(0.99); }
  .btn-success { background: #16a34a; }
  .btn-danger { background: #dc2626; }
  .btn-secondary { background: #334155; }
  .btn-block { width: 100%; }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .item-box {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 12px;
    word-break: break-word;
  }
  .badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
  }
  .badge-on { background: rgba(22, 163, 74, .2); color: #4ade80; }
  .badge-off { background: rgba(239, 68, 68, .2); color: #f87171; }
  .muted { color: #94a3b8; font-size: 14px; }
  code {
    background: #1e293b;
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 13px;
  }
  #toast {
    position: fixed;
    bottom: 18px;
    right: 18px;
    left: 18px;
    max-width: 420px;
    margin-left: auto;
    background: #16a34a;
    color: #fff;
    padding: 12px 16px;
    border-radius: 10px;
    font-weight: 700;
    display: none;
    z-index: 99;
    box-shadow: 0 8px 20px rgba(0,0,0,.4);
  }
`;

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0" />
  <title>Login — Painel Master</title>
  <style>
    ${BASE_STYLES}
    .center-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .login-card { width: 100%; max-width: 400px; }
    .err { color: #f87171; font-size: 14px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="center-wrap">
    <div class="card login-card">
      <h2>Painel Master</h2>
      ${req.query.error ? '<div class="err">Senha incorreta.</div>' : ''}
      <form method="POST" action="/login">
        <label>Senha Master</label>
        <input type="password" name="password" required autofocus />
        <button class="btn btn-block" type="submit">Entrar</button>
      </form>
    </div>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const masterPass = (process.env.MASTER_PASSWORD || '').trim();
  const inputPass = (req.body.password || '').trim();

  if (masterPass && inputPass === masterPass) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/api/state', requireAuth, async (req, res) => {
  try {
    const licenses = await db.getAllLicenses();
    const clients = groupByOwner(licenses);
    res.json({ ok: true, licenses, clients });
  } catch (err) {
    console.error('Erro ao buscar estado:', err);
    res.status(500).json({ ok: false, error: 'Erro ao carregar dados do banco.' });
  }
});

app.get('/api/clients/:ownerId', requireAuth, async (req, res) => {
  try {
    const ownerId = String(req.params.ownerId).trim();
    const history = await db.getClientFullHistory(ownerId);
    res.json({ ok: true, owner_id: ownerId, stores: history });
  } catch (err) {
    console.error('Erro ao carregar ficha do cliente:', err);
    res.status(500).json({ ok: false, error: 'Erro ao carregar histórico completo.' });
  }
});

app.post('/api/licenses', requireAuth, async (req, res) => {
  try {
    const { guild_id, owner_id, store_name, days } = req.body;
    if (!guild_id || !owner_id || !store_name || !days) {
      return res.status(400).json({ ok: false, error: 'Preencha ID do servidor, ID do dono, nome da loja e dias.' });
    }

    const lic = await db.upsertLicense(
      String(guild_id).trim(),
      String(owner_id).trim(),
      String(store_name).trim(),
      Number(days)
    );

    await notifyLicenseActivated(lic).catch((e) => console.warn('Aviso ativação:', e.message));

    const allLicenses = await db.getAllLicenses();
    return res.json({ ok: true, license: lic, clients: groupByOwner(allLicenses) });
  } catch (err) {
    console.error('Erro ao criar/ativar loja:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao salvar loja.' });
  }
});

app.patch('/api/licenses/:guildId', requireAuth, async (req, res) => {
  try {
    const { guildId } = req.params;
    const { owner_id, store_name, days, active } = req.body;

    const updated = await db.updateLicenseDetails(guildId, {
      ownerId: owner_id,
      storeName: store_name,
      days: days !== undefined && days !== '' ? Number(days) : undefined,
      active: typeof active === 'boolean' ? active : undefined
    });

    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Loja não encontrada.' });
    }

    const allLicenses = await db.getAllLicenses();
    return res.json({ ok: true, license: updated, clients: groupByOwner(allLicenses) });
  } catch (err) {
    console.error('Erro ao atualizar loja:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao atualizar informações.' });
  }
});

app.delete('/api/licenses/:guildId', requireAuth, async (req, res) => {
  try {
    const ok = await db.deleteLicense(req.params.guildId);
    if (!ok) return res.status(404).json({ ok: false, error: 'Loja não encontrada.' });
    const allLicenses = await db.getAllLicenses();
    return res.json({ ok: true, clients: groupByOwner(allLicenses) });
  } catch (err) {
    console.error('Erro ao remover loja:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao remover loja.' });
  }
});

app.delete('/api/clients/:ownerId', requireAuth, async (req, res) => {
  try {
    const count = await db.deleteOwnerAndStores(req.params.ownerId);
    if (!count) return res.status(404).json({ ok: false, error: 'Cliente não encontrado.' });
    const allLicenses = await db.getAllLicenses();
    return res.json({ ok: true, removedStores: count, clients: groupByOwner(allLicenses) });
  } catch (err) {
    console.error('Erro ao remover cliente:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao remover cliente.' });
  }
});

// PÁGINA PRINCIPAL (TELA CHEIA RESPONSIVA)
app.get('/', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0" />
  <title>Painel Master — Clientes & Lojas</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="page">
    <header>
      <div>
        <h1>Painel Master</h1>
        <div class="muted">Gerencie clientes, lojas e abra a ficha completa em nova aba.</div>
      </div>
      <form method="POST" action="/logout">
        <button class="btn btn-secondary" type="submit">Sair</button>
      </form>
    </header>

    <div class="layout">
      <div class="card">
        <h2>Ativar / Adicionar Loja</h2>
        <form id="createForm">
          <label>ID do Dono (Cliente no Discord)</label>
          <input type="text" name="owner_id" required placeholder="Ex: 123456789012345678" />

          <label>ID do Servidor (Loja)</label>
          <input type="text" name="guild_id" required placeholder="Ex: 987654321098765432" />

          <label>Nome da Loja</label>
          <input type="text" name="store_name" required placeholder="Ex: Loja do João" />

          <label>Dias de Aluguel</label>
          <input type="number" name="days" min="1" value="30" required />

          <button class="btn btn-success btn-block" type="submit">Ativar Loja e Notificar</button>
        </form>
      </div>

      <div class="card">
        <h2>Clientes Cadastrados (<span id="clientCount">0</span>)</h2>
        <div id="clientsList"><div class="muted">Carregando clientes...</div></div>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    let state = { clients: [], licenses: [] };

    function showToast(msg, isError = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.background = isError ? '#dc2626' : '#16a34a';
      el.style.display = 'block';
      clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
    }

    async function loadState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      if (data.ok) {
        state = data;
        renderClients();
      }
    }

    function renderClients() {
      const listEl = document.getElementById('clientsList');
      document.getElementById('clientCount').textContent = state.clients.length;

      if (!state.clients.length) {
        listEl.innerHTML = '<div class="muted">Nenhum cliente cadastrado ainda.</div>';
        return;
      }

      listEl.innerHTML = state.clients.map(c => {
        const storeBadges = c.stores.map(s =>
          \`<span class="badge \${s.isOperational ? 'badge-on' : 'badge-off'}" style="margin-right:6px; margin-top:4px;">\${escapeHtml(s.store_name)} (\${s.daysLeft}d)</span>\`
        ).join('');

        return \`
          <div class="item-box">
            <div><strong>Cliente ID:</strong> <code>\${c.owner_id}</code></div>
            <div class="muted" style="margin-top:4px;">Total de lojas: <strong>\${c.stores.length}</strong> • Ativas: <strong>\${c.activeStores}</strong></div>
            <div style="margin-top:6px;">\${storeBadges}</div>
            <div class="actions">
              <a class="btn" href="/cliente/\${encodeURIComponent(c.owner_id)}" target="_blank" rel="noopener">Editar / Ver Tudo (Nova Aba)</a>
              <button class="btn btn-danger" type="button" onclick="removeClient('\${c.owner_id}')">Remover Cliente</button>
            </div>
          </div>
        \`;
      }).join('');
    }

    async function removeClient(ownerId) {
      if (!confirm('Remover este cliente e TODAS as lojas/produtos dele da lista?')) return;
      const res = await fetch('/api/clients/' + encodeURIComponent(ownerId), { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        state.clients = data.clients;
        renderClients();
        showToast('Cliente removido da lista!');
      } else {
        showToast(data.error || 'Erro ao remover cliente', true);
      }
    }

    document.getElementById('createForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(new FormData(e.target).entries());

      const res = await fetch('/api/licenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok) {
        state.clients = data.clients;
        e.target.reset();
        e.target.days.value = 30;
        renderClients();
        showToast('Loja ativada e avisos enviados!');
      } else {
        showToast(data.error || 'Erro ao ativar loja', true);
      }
    });

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[m]));
    }

    loadState();
  </script>
</body>
</html>`);
});

// NOVA ABA DO CLIENTE COM TUDO QUE ELE FEZ + EDIÇÃO INSTANTÂNEA + REMOÇÃO
app.get('/cliente/:ownerId', requireAuth, (req, res) => {
  const ownerId = String(req.params.ownerId).trim();

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0" />
  <title>Ficha do Cliente — ${ownerId}</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="page">
    <header>
      <div>
        <h1>Ficha Completa do Cliente</h1>
        <div class="muted">ID Discord: <code>${ownerId}</code></div>
      </div>
      <div class="actions" style="margin-top:0;">
        <button class="btn btn-danger" type="button" onclick="deleteEntireClient()">Remover Cliente da Lista</button>
        <button class="btn btn-secondary" type="button" onclick="window.close()">Fechar Aba</button>
      </div>
    </header>

    <div id="content"><div class="muted">Carregando tudo que o cliente criou...</div></div>
  </div>

  <div id="toast"></div>

  <script>
    const OWNER_ID = ${JSON.stringify(ownerId)};

    function showToast(msg, isError = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.background = isError ? '#dc2626' : '#16a34a';
      el.style.display = 'block';
      clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
    }

    async function loadClientData() {
      const res = await fetch('/api/clients/' + encodeURIComponent(OWNER_ID));
      const data = await res.json();
      const container = document.getElementById('content');

      if (!data.ok || !data.stores.length) {
        container.innerHTML = '<div class="card"><div class="muted">Nenhuma loja ou atividade encontrada para este cliente.</div></div>';
        return;
      }

      const totalProducts = data.stores.reduce((acc, s) => acc + s.products.length, 0);
      const totalStock = data.stores.reduce((acc, s) => acc + s.products.reduce((a, p) => a + p.stockCount, 0), 0);

      let html = \`
        <div class="card" style="margin-bottom:18px;">
          <h2>Resumo Geral do Cliente</h2>
          <div class="muted">
            • <strong>Lojas criadas:</strong> \${data.stores.length}<br/>
            • <strong>Total de produtos cadastrados:</strong> \${totalProducts}<br/>
            • <strong>Total de itens em estoque:</strong> \${totalStock}
          </div>
        </div>
      \`;

      html += data.stores.map(store => {
        const productsHtml = store.products.length
          ? store.products.map(p => \`
              <div class="item-box" style="margin-bottom:8px;">
                <div><strong>Produto ID #\${p.id}</strong> — \${escapeHtml(p.name)}</div>
                <div class="muted">Preço: <strong>R$ \${Number(p.price).toFixed(2)}</strong> • Estoque: <strong>\${p.stockCount}</strong></div>
                <div class="muted">\${escapeHtml(p.description)}</div>
              </div>
            \`).join('')
          : '<div class="muted">Nenhum produto criado nesta loja ainda.</div>';

        return \`
          <div class="card" style="margin-bottom:18px;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
              <div>
                <h2 style="margin:0;">Loja: \${escapeHtml(store.store_name)}</h2>
                <div class="muted">Servidor ID: <code>\${store.guild_id}</code></div>
              </div>
              <span class="badge \${store.isOperational ? 'badge-on' : 'badge-off'}">\${store.isOperational ? 'Ativo (' + store.daysLeft + 'd)' : 'Bloqueado / Vencido'}</span>
            </div>

            <div class="muted" style="margin-bottom:14px;">
              • <strong>PIX Mercado Pago:</strong> \${store.mp_token ? '✅ Configurado' : '❌ Não configurado'}<br/>
              • <strong>Foto exclusiva do servidor:</strong> \${store.store_photo ? '<a href="' + escapeHtml(store.store_photo) + '" target="_blank" style="color:#60a5fa;">Ver imagem configurada</a>' : 'Não definida'}
            </div>

            <form onsubmit="saveStore(event, '\${store.guild_id}')">
              <label>ID do Dono (Transferir / Editar)</label>
              <input type="text" name="owner_id" value="\${escapeHtml(store.owner_id)}" required />

              <label>Nome da Loja</label>
              <input type="text" name="store_name" value="\${escapeHtml(store.store_name)}" required />

              <label>Dias Restantes a partir de hoje</label>
              <input type="number" name="days" min="0" value="\${store.daysLeft}" required />

              <label>Status do Robô</label>
              <select name="active">
                <option value="true" \${store.active ? 'selected' : ''}>Ativo (Ligado)</option>
                <option value="false" \${!store.active ? 'selected' : ''}>Bloqueado (Desligado)</option>
              </select>

              <div class="actions">
                <button class="btn btn-success" type="submit">Salvar Alterações Agora</button>
                <button class="btn btn-danger" type="button" onclick="removeStore('\${store.guild_id}')">Remover Esta Loja</button>
              </div>
            </form>

            <hr style="border:0; border-top:1px solid #334155; margin:18px 0;" />
            <h2>Produtos Criados Nesta Loja (\${store.products.length})</h2>
            \${productsHtml}
          </div>
        \`;
      }).join('');

      container.innerHTML = html;
    }

    async function saveStore(e, guildId) {
      e.preventDefault();
      const form = e.target;
      const payload = {
        owner_id: form.owner_id.value.trim(),
        store_name: form.store_name.value.trim(),
        days: Number(form.days.value),
        active: form.active.value === 'true'
      };

      const res = await fetch('/api/licenses/' + encodeURIComponent(guildId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok) {
        showToast('Alterações salvas instantaneamente!');
        loadClientData();
      } else {
        showToast(data.error || 'Erro ao salvar', true);
      }
    }

    async function removeStore(guildId) {
      if (!confirm('Remover esta loja e todos os produtos dela?')) return;
      const res = await fetch('/api/licenses/' + encodeURIComponent(guildId), { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        showToast('Loja removida!');
        loadClientData();
      } else {
        showToast(data.error || 'Erro ao remover loja', true);
      }
    }

    async function deleteEntireClient() {
      if (!confirm('Remover este cliente e TODAS as lojas dele da lista?')) return;
      const res = await fetch('/api/clients/' + encodeURIComponent(OWNER_ID), { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        showToast('Cliente removido com sucesso!');
        setTimeout(() => { window.location.href = '/'; }, 900);
      } else {
        showToast(data.error || 'Erro ao remover cliente', true);
      }
    }

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[m]));
    }

    loadClientData();
  </script>
</body>
</html>`);
});

function startWeb() {
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Painel Master online na porta ${port}`);
  });
}

module.exports = { startWeb, app };
