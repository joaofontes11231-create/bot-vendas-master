const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./database');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo_super_seguro',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 }
}));

function requireMasterAuth(req, res, next) {
  if (req.session && req.session.isMaster) return next();
  res.redirect('/login');
}

// Rota pública para manter o Render acordado
app.get('/ping', (req, res) => res.status(200).send('OK'));

app.get('/login', (req, res) => res.render('login', { error: null }));

app.post('/login', (req, res) => {
  if (req.body.password === process.env.MASTER_PASSWORD) {
    req.session.isMaster = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'Senha incorreta!' });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/', requireMasterAuth, async (req, res) => {
  const licenses = await db.getAllLicenses();
  res.render('dashboard', { licenses });
});

app.post('/ativar', requireMasterAuth, async (req, res) => {
  const { guild_id, owner_id, store_name, days } = req.body;
  await db.upsertLicense(guild_id.trim(), owner_id.trim(), store_name.trim(), parseInt(days, 10));
  res.redirect('/');
});

app.post('/bloquear/:guildId', requireMasterAuth, async (req, res) => {
  await db.setLicenseStatus(req.params.guildId, false);
  res.redirect('/');
});

app.post('/desbloquear/:guildId', requireMasterAuth, async (req, res) => {
  await db.setLicenseStatus(req.params.guildId, true);
  res.redirect('/');
});

app.post('/renovar/:guildId', requireMasterAuth, async (req, res) => {
  const days = parseInt(req.body.extra_days, 10) || 30;
  await db.addDays(req.params.guildId, days);
  res.redirect('/');
});

app.post('/remover/:guildId', requireMasterAuth, async (req, res) => {
  await db.deleteLicense(req.params.guildId);
  res.redirect('/');
});

module.exports = {
  startWeb: () => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`🌐 Painel Master online na porta ${port}`));
  }
};