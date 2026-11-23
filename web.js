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
        activeStores: 0,
        totalDaysRemaining: 0
      });
    }
    const group = map.get(ownerId);
    group.stores.push(lic);
    if (lic.isOperational) group.activeStores += 1;
    group.totalDaysRemaining += Number(lic.daysLeft || 0);
  }

  return Array.from(map.values());
}

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Login — Painel Master</title>
  <style>
    body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 28px; border-radius: 12px; width: 100%; max-width: 360px; box-shadow: 0 10px 25px rgba(0,0,0,.35); }
    h2 { margin-top: 0; font-size: 20px; }
    input { width: 100%; padding: 10px; margin: 10px 0 16px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #fff; box-sizing: border-box; }
    button { width: 100%; padding: 11px; border: none; border-radius: 8px; background: #2563eb; color: #fff; font-weight: bold; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .err { color: #f87171; font-size: 13px; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Painel Master</h2>
    ${req.query.error ? '<div class="err">Senha incorreta.</div>' : ''}
    <form method="POST" action="/login">
      <label>Senha Master</label>
      <input type="password" name="password" required autofocus />
      <button type="submit">Entrar</button>
    </form>
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

app.get('/', requireAuth, async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Painel Master — Clientes e Lojas</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 1120px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; gap: 12px; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 22px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1.4fr; gap: 20px; }
    @media (max-width: 860px) { .grid-2 { grid-template-columns: 1fr; } }
    .panel { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .panel h2 { margin-top: 0; font-size: 17px; margin-bottom: 14px; }
    label { display: block; font-size: 13px; color: #cbd5e1; margin-bottom: 4px; }
    input, select { width: 100%; padding: 9px 10px; margin-bottom: 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: #fff; }
    button { padding: 9px 14px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; background: #2563eb; color: #fff; }
    button:hover { opacity: 0.92; }
    button.secondary { background: #334155; }
    button.success { background: #16a34a; }
    .client-card { background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 14px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .store-item { background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 14px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; font-weight: bold; }
    .badge.on { background: rgba(22, 163, 74, .2); color: #4ade80; }
    .badge.off { background: rgba(239, 68, 68, .2); color: #f87171; }
    .muted { color: #94a3b8; font-size: 13px; }
    .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.65); display: none; justify-content: center; align-items: center; padding: 16px; z-index: 50; }
    .modal-backdrop.open { display: flex; }
    .modal { background: #1e293b; border: 1px solid #475569; border-radius: 12px; padding: 22px; width: 100%; max-width: 440px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
    #toast { position: fixed; bottom: 20px; right: 20px; background: #16a34a; color: #fff; padding: 10px 16px; border-radius: 8px; font-weight: bold; display: none; z-index: 60; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Painel Master — Clientes & Lojas</h1>
        <div class="muted">Cada cliente pode ter várias lojas. Abra o perfil para ver todas e editar na hora.</div>
      </div>
      <form method="POST" action="/logout"><button class="secondary" type="submit">Sair</button></form>
    </header>

    <div class="grid-2">
      <div class="panel">
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

          <button class="success" type="submit" style="width:100%;">Ativar Loja e Notificar</button>
        </form>
      </div>

      <div class="panel" id="rightPanel">
        <div id="clientsView">
          <h2>Clientes Cadastrados</h2>
          <div id="clientsList"><div class="muted">Carregando...</div></div>
        </div>

        <div id="profileView" style="display:none;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; gap:10px;">
            <div>
              <h2 style="margin:0;">Perfil do Cliente</h2>
              <div class="muted" id="profileOwnerId"></div>
            </div>
            <button class="secondary" type="button" onclick="backToClients()">Voltar aos Clientes</button>
          </div>
          <div id="profileSummary" style="margin-bottom:14px;"></div>
          <div id="profileStores"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="editModal">
    <div class="modal">
      <h2 style="margin-top:0;">Editar Informações da Loja / Cliente</h2>
      <form id="editForm">
        <input type="hidden" name="original_guild_id" id="editOriginalGuildId" />

        <label>ID do Dono (Cliente)</label>
        <input type="text" name="owner_id" id="editOwnerId" required />

        <label>Nome da Loja</label>
        <input type="text" name="store_name" id="editStoreName" required />

        <label>Definir Dias Restantes a partir de hoje</label>
        <input type="number" name="days" id="editDays" min="0" required />

        <label>Status do Robô</label>
        <select name="active" id="editActive">
          <option value="true">Ativo (Ligado)</option>
          <option value="false">Bloqueado (Desligado)</option>
        </select>

        <div class="modal-actions">
          <button type="button" class="secondary" onclick="closeEditModal()">Cancelar</button>
          <button type="submit" class="success">Salvar e Atualizar</button>
        </div>
      </form>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    let state = { clients: [], licenses: [] };
    let selectedOwnerId = null;

    function showToast(msg, isError = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.style.background = isError ? '#dc2626' : '#16a34a';
      el.style.display = 'block';
      clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2800);
    }

    async function loadState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      if (data.ok) {
        state = data;
        renderAll();
      }
    }

    function renderAll() {
      const listEl = document.getElementById('clientsList');
      if (!state.clients.length) {
        listEl.innerHTML = '<div class="muted">Nenhum cliente cadastrado ainda.</div>';
      } else {
        listEl.innerHTML = state.clients.map(c => \`
          <div class="client-card">
            <div>
              <div><strong>Cliente ID:</strong> <code>\${c.owner_id}</code></div>
              <div class="muted">Lojas: <strong>\${c.stores.length}</strong> • Ativas: <strong>\${c.activeStores}</strong></div>
            </div>
            <button type="button" onclick="openProfile('\${c.owner_id}')">Perfil dele</button>
          </div>
        \`).join('');
      }

      if (selectedOwnerId) {
        renderProfile(selectedOwnerId);
      }
    }

    function openProfile(ownerId) {
      selectedOwnerId = ownerId;
      document.getElementById('clientsView').style.display = 'none';
      document.getElementById('profileView').style.display = 'block';
      renderProfile(ownerId);
    }

    function backToClients() {
      selectedOwnerId = null;
      document.getElementById('profileView').style.display = 'none';
      document.getElementById('clientsView').style.display = 'block';
    }

    function renderProfile(ownerId) {
      const client = state.clients.find(c => c.owner_id === ownerId);
      document.getElementById('profileOwnerId').textContent = 'ID Discord: ' + ownerId;

      if (!client || !client.stores.length) {
        document.getElementById('profileSummary').innerHTML = '';
        document.getElementById('profileStores').innerHTML = '<div class="muted">Nenhuma loja vinculada a este cliente.</div>';
        return;
      }

      document.getElementById('profileSummary').innerHTML =
        '<div class="muted">Total de lojas criadas: <strong>' + client.stores.length + '</strong> • Lojas ativas: <strong>' + client.activeStores + '</strong></div>';

      document.getElementById('profileStores').innerHTML = client.stores.map(s => \`
        <div class="store-item">
          <div>
            <div>
              <strong>\${escapeHtml(s.store_name)}</strong>
              <span class="badge \${s.isOperational ? 'on' : 'off'}">\${s.isOperational ? 'Ativo' : 'Bloqueado/Vencido'}</span>
            </div>
            <div class="muted">Servidor: <code>\${s.guild_id}</code> • Restam: <strong>\${s.daysLeft} dia(s)</strong> • PIX: \${s.mp_token ? 'Sim' : 'Não'}</div>
          </div>
          <button type="button" onclick="openEditModal('\${s.guild_id}')">Editar</button>
        </div>
      \`).join('');
    }

    function openEditModal(guildId) {
      const lic = state.licenses.find(l => l.guild_id === guildId);
      if (!lic) return;
      document.getElementById('editOriginalGuildId').value = lic.guild_id;
      document.getElementById('editOwnerId').value = lic.owner_id;
      document.getElementById('editStoreName').value = lic.store_name;
      document.getElementById('editDays').value = lic.daysLeft;
      document.getElementById('editActive').value = lic.active ? 'true' : 'false';
      document.getElementById('editModal').classList.add('open');
    }

    function closeEditModal() {
      document.getElementById('editModal').classList.remove('open');
    }

    document.getElementById('createForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const payload = Object.fromEntries(formData.entries());

      const res = await fetch('/api/licenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok) {
        state.licenses = data.license ? upsertLocalLicense(state.licenses, data.license) : state.licenses;
        state.clients = data.clients;
        e.target.reset();
        e.target.days.value = 30;
        renderAll();
        showToast('Loja ativada e avisos enviados!');
      } else {
        showToast(data.error || 'Erro ao ativar loja', true);
      }
    });

    document.getElementById('editForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const guildId = document.getElementById('editOriginalGuildId').value;
      const payload = {
        owner_id: document.getElementById('editOwnerId').value.trim(),
        store_name: document.getElementById('editStoreName').value.trim(),
        days: Number(document.getElementById('editDays').value),
        active: document.getElementById('editActive').value === 'true'
      };

      const res = await fetch('/api/licenses/' + encodeURIComponent(guildId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.ok) {
        state.licenses = upsertLocalLicense(state.licenses, data.license);
        state.clients = data.clients;
        if (selectedOwnerId && selectedOwnerId !== data.license.owner_id) {
          selectedOwnerId = data.license.owner_id;
        }
        closeEditModal();
        renderAll();
        showToast('Informações atualizadas instantaneamente!');
      } else {
        showToast(data.error || 'Erro ao atualizar', true);
      }
    });

    function upsertLocalLicense(list, item) {
      const idx = list.findIndex(x => x.guild_id === item.guild_id);
      if (idx >= 0) {
        const copy = [...list];
        copy[idx] = item;
        return copy;
      }
      return [item, ...list];
    }

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

function startWeb() {
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Painel Master online na porta ${port}`);
  });
}

module.exports = { startWeb, app };
