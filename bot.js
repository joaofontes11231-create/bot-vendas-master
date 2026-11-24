const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const db = require('./database');
const mp = require('./mercadopago');

const OFFICIAL_DISCORD = 'https://discord.gg/ZQzv7U3Vnw';

const LOCKED_MSG =
  `🤖 **Sistema de Hospedagem & Vendas**\n` +
  `• **Estado do Robô:** 🔴 Desligado (Aguardando ativação)\n` +
  `• **Discord Oficial:** ${OFFICIAL_DISCORD}\n` +
  `*Entre em contato no servidor oficial para ativar o sistema.*`;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.on('error', (err) => console.error('❌ Erro no client:', err));
client.on('shardError', (err) => console.error('❌ Erro de shard/WebSocket:', err));

function isValidImageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function formatDateBR(ts) {
  return new Date(Number(ts)).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function resolveServerDisplayName(license) {
  if (license?.server_name && String(license.server_name).trim()) {
    return String(license.server_name).trim();
  }
  const guild = client.guilds.cache.get(license.guild_id) || (await client.guilds.fetch(license.guild_id).catch(() => null));
  return guild?.name || license.store_name || 'Servidor';
}

async function findMainTextChannel(guild) {
  if (!guild) return null;
  await guild.channels.fetch().catch(() => null);
  const me = guild.members.me;
  if (!me) return null;

  if (guild.systemChannel && guild.systemChannel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
    return guild.systemChannel;
  }

  return (
    guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
    ) || null
  );
}

async function sendUserAlert(userId, content) {
  try {
    const user = await client.users.fetch(userId);
    if (user) await user.send(content);
  } catch {
    // DM fechada
  }
}

async function notifyLicenseActivated(license) {
  if (!license) return;
  const serverDisplayName = await resolveServerDisplayName(license);

  const dmText =
    `✅ **Robô Profissional de Hospedagem Ativado!**\n\n` +
    `🏢 **Empresa/Loja:** ${license.store_name}\n` +
    `🖥️ **Servidor:** **${serverDisplayName}**\n` +
    `⚡ **Estado do Robô:** 🟢 Ligado / Ativo 24h\n` +
    `⏳ **Prazo:** **${license.daysLeft} dia(s)**\n` +
    `💬 **Discord Oficial:** ${OFFICIAL_DISCORD}`;

  await sendUserAlert(license.owner_id, dmText);

  const guild = client.guilds.cache.get(license.guild_id) || (await client.guilds.fetch(license.guild_id).catch(() => null));
  if (guild) {
    const channel = await findMainTextChannel(guild);
    if (channel) {
      await channel.send(
        `🟢 **Robô de Hospedagem Ligado e Ativo!**\n` +
        `• **Empresa:** **${license.store_name}**\n` +
        `• **Servidor:** **${serverDisplayName}**\n` +
        `• **Dono:** <@${license.owner_id}>\n` +
        `• **Duração:** **${license.daysLeft} dia(s)**\n` +
        `• **Discord Oficial:** ${OFFICIAL_DISCORD}`
      ).catch(() => {});
    }
  }
}

async function notifyLicenseBlocked(license, reason) {
  if (!license) return;
  const serverDisplayName = await resolveServerDisplayName(license);
  const finalReason = reason && String(reason).trim()
    ? String(reason).trim()
    : (license.block_reason || 'Bloqueado pela administração');

  await sendUserAlert(
    license.owner_id,
    `🔒 **Aviso de Bloqueio — ${license.store_name}**\n\n` +
    `🖥️ **Servidor:** **${serverDisplayName}**\n` +
    `⚡ **Estado do Robô:** 🔴 Bloqueado\n` +
    `📝 **Motivo:** **${finalReason}**\n` +
    `💬 **Discord Oficial:** ${OFFICIAL_DISCORD}`
  );
}

client.on('guildCreate', async (guild) => {
  try {
    const ch = await findMainTextChannel(guild);
    if (ch) await ch.send(LOCKED_MSG);
  } catch (err) {
    console.error('❌ Erro ao enviar aviso inicial:', err);
  }
});

// PAINÉIS FIXOS (MASTER, DONO, CLIENTE, TICKET)
function renderTicketFixedPanel(storeName, storePhoto) {
  const embed = new EmbedBuilder()
    .setTitle(`🎫 Central de Atendimento — ${storeName}`)
    .setDescription(
      'Escolha abaixo a categoria do seu atendimento para abrir um canal privado com a equipe:\n\n' +
      '• 🛠️ **Suporte Técnico:** configuração, painel, acesso ou dúvidas técnicas\n' +
      '• 💠 **Financeiro / PIX:** comprovantes, renovações, cupons ou reembolsos\n' +
      '• 🛒 **Vendas / Planos:** contratação de hospedagem ou planos personalizados'
    )
    .setColor('#3498db')
    .setFooter({ text: 'Painel fixo de tickets • Atendimento organizado' });

  if (storePhoto && isValidImageUrl(storePhoto)) {
    embed.setThumbnail(storePhoto);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('open_ticket_tecnico').setLabel('Suporte Técnico').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('open_ticket_financeiro').setLabel('Financeiro / PIX').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('open_ticket_vendas').setLabel('Vendas / Planos').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

async function renderMasterFixedPanel() {
  const m = await db.getGlobalMetrics();

  const embed = new EmbedBuilder()
    .setTitle('👑 CENTRAL ADMINISTRATIVA — MASTER (24H)')
    .setDescription(`🟢 **SISTEMA ATIVO** • Atualizado às ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`)
    .addFields(
      { name: '👥 Clientes (Donos)', value: `**${m.totalClients}**`, inline: true },
      { name: '🏢 Lojas Ativas', value: `**${m.activeStores}/${m.totalStores}**`, inline: true },
      { name: '🖥️ Hospedagens Ativas', value: `**${m.activeHostings}/${m.totalHostings}**`, inline: true },
      { name: '💰 Vendas Aprovadas', value: `**R$ ${m.totalRevenue.toFixed(2)}** (${m.approvedOrdersCount})`, inline: true },
      { name: '⏳ Pedidos Pendentes', value: `**${m.pendingOrdersCount}**`, inline: true },
      { name: '⭐ Avaliação Média', value: `**${m.avgRating}★** (${m.reviewsCount})`, inline: true }
    )
    .setColor('#f1c40f')
    .setFooter({ text: 'Painel fixo atualizado automaticamente 24h' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fp_refresh_master').setLabel('Atualizar Agora').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('fp_master_clients').setLabel('Ver Clientes').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('fp_master_pending').setLabel('Pedidos Pendentes').setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}

async function renderOwnerFixedPanel(guildId) {
  const license = await db.getLicense(guildId);
  if (!license) {
    return {
      embeds: [new EmbedBuilder().setTitle('⚠️ Loja não licenciada').setDescription(LOCKED_MSG).setColor('#e74c3c')],
      components: []
    };
  }

  const products = await db.getProductsByGuild(guildId);
  const hostings = await db.getHostingsByGuild(guildId);
  const orders = await db.getOrdersByGuild(guildId);
  const pending = orders.filter(o => o.status === 'pending');
  const activeHos = hostings.filter(h => h.status === 'active');
  const revenue = orders.filter(o => o.status === 'approved').reduce((a, b) => a + Number(b.final_price || 0), 0);

  const embed = new EmbedBuilder()
    .setTitle(`🏢 PAINEL DE GERENCIAMENTO — ${license.store_name}`)
    .setDescription(
      `${license.isOperational ? '🟢 **SISTEMA ONLINE**' : '🔴 **SISTEMA PAUSADO/MANUTENÇÃO**'} • Atualizado às ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
    )
    .addFields(
      { name: '🖥️ Servidor', value: `**${license.server_name}**`, inline: true },
      { name: '⏳ Licença do Robô', value: `**${license.daysLeft} dia(s)**`, inline: true },
      { name: '💳 Chave PIX', value: license.pix_key ? `\`${license.pix_key}\`` : '❌ Não definida', inline: true },
      { name: '📦 Planos Ativos', value: `**${products.length}**`, inline: true },
      { name: '🖥️ Hospedagens Ativas', value: `**${activeHos.length}/${hostings.length}**`, inline: true },
      { name: '💰 Faturamento', value: `**R$ ${revenue.toFixed(2)}** (${pending.length} pendente(s))`, inline: true }
    )
    .setColor('#2ecc71')
    .setFooter({ text: 'Painel fixo do dono • Atualização automática 24h' });

  if (license.store_photo && isValidImageUrl(license.store_photo)) {
    embed.setThumbnail(license.store_photo);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fp_refresh_owner').setLabel('Atualizar Painel').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('fp_owner_orders').setLabel(`Pedidos Pendentes (${pending.length})`).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('fp_owner_hostings').setLabel('Hospedagens').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

async function renderCustomerFixedPanel(guildId, customerId) {
  const license = await db.getLicense(guildId);
  const hostings = await db.getHostingsByCustomer(customerId, guildId);
  const latest = hostings[0];

  const embed = new EmbedBuilder()
    .setTitle(`🖥️ PAINEL DE HOSPEDAGEM — ${license ? license.store_name : 'Cliente'}`)
    .setFooter({ text: `Cliente ID: ${customerId} • Atualização automática 24h` });

  if (!latest) {
    embed
      .setDescription('🔴 **NENHUMA HOSPEDAGEM ATIVA**\nVocê ainda não possui hospedagens aprovadas neste servidor.')
      .setColor('#95a5a6');
  } else {
    const isOnline = latest.status === 'active';
    embed
      .setDescription(`${isOnline ? '🟢 **ONLINE**' : '🔴 **SUSPENSO / VENCIDO**'} • Atualizado às ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`)
      .addFields(
        { name: '🆔 ID da Hospedagem', value: `**${latest.code}**`, inline: true },
        { name: '📦 Plano', value: `**${latest.plan_name}**`, inline: true },
        { name: '⚡ Status', value: isOnline ? 'Ativo' : 'Suspenso', inline: true },
        { name: '📅 Contratação', value: formatDateBR(latest.created_at), inline: true },
        { name: '⏳ Vencimento', value: `${formatDateBR(latest.expires_at)} (**${latest.daysLeft}d**)`, inline: true },
        { name: '📊 Total de Serviços', value: `${hostings.length} hospedagem(ns)`, inline: true },
        { name: '⚙️ Recursos', value: `${latest.specs || 'Conforme o plano'}\n🔐 Dados de acesso disponíveis somente por mensagem privada.` }
      )
      .setColor(isOnline ? '#2ecc71' : '#e74c3c');
  }

  if (license?.store_photo && isValidImageUrl(license.store_photo)) {
    embed.setThumbnail(license.store_photo);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('fp_cust_renew_' + customerId + '_' + (latest ? latest.code : 'none')).setLabel('Renovar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`fp_cust_invoices_${customerId}`).setLabel('Faturas').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`fp_cust_support_${customerId}`).setLabel('Suporte').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`fp_cust_refresh_${customerId}`).setLabel('Atualizar').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

async function refreshAllFixedPanels() {
  const panels = await db.getAllFixedPanels();
  for (const p of panels) {
    try {
      const channel = client.channels.cache.get(p.channel_id) || (await client.channels.fetch(p.channel_id).catch(() => null));
      if (!channel || !channel.isTextBased()) {
        await db.removeFixedPanel(p.message_id);
        continue;
      }
      const msg = await channel.messages.fetch(p.message_id).catch(() => null);
      if (!msg) {
        await db.removeFixedPanel(p.message_id);
        continue;
      }

      let payload = null;
      if (p.panel_type === 'master') payload = await renderMasterFixedPanel();
      if (p.panel_type === 'owner') payload = await renderOwnerFixedPanel(p.guild_id);
      if (p.panel_type === 'customer') payload = await renderCustomerFixedPanel(p.guild_id, p.target_id);
      if (p.panel_type === 'ticket') {
        const lic = await db.getLicense(p.guild_id);
        payload = renderTicketFixedPanel(lic?.store_name || 'Atendimento', lic?.store_photo || null);
      }

      if (payload) await msg.edit(payload);
    } catch (err) {
      console.warn('⚠️ Falha ao atualizar painel fixo:', err.message);
    }
  }
}

function calcDaysExact(expiresAt, now = Date.now()) {
  const diff = Number(expiresAt) - now;
  if (diff <= 0) return 0;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

async function runScheduledChecks() {
  try {
    const allHostings = await db.getAllHostings();
    const now = Date.now();

    for (const hos of allHostings) {
      const daysLeft = calcDaysExact(hos.expires_at, now);

      for (const milestone of [7, 3, 1]) {
        if (hos.status === 'active' && daysLeft === milestone) {
          const ref = `hos_${hos.code}_warn_${milestone}d`;
          if (!(await db.wasNotified(ref))) {
            await sendUserAlert(
              hos.customer_id,
              `⚠️ **Aviso de Vencimento — ${hos.code}**\n` +
              `Sua hospedagem **${hos.plan_name}** vence em **${milestone} dia(s)** (${formatDateBR(hos.expires_at)}).\n` +
              `Use \`/painel\` no servidor para renovar e evitar suspensão!`
            );
            await db.markNotified(ref);
          }
        }
      }

      if (hos.status === 'active' && hos.expires_at <= now) {
        await db.updateHostingStatus(hos.code, 'suspended');
        const refExp = `hos_${hos.code}_expired`;
        if (!(await db.wasNotified(refExp))) {
          await sendUserAlert(
            hos.customer_id,
            `🔴 **Hospedagem Suspensa por Vencimento — ${hos.code}**\n` +
            `Sua hospedagem **${hos.plan_name}** venceu em ${formatDateBR(hos.expires_at)} e foi suspensa.`
          );
          await db.markNotified(refExp);
        }
      }
    }

    const licenses = await db.getAllLicenses();
    for (const lic of licenses) {
      if (lic.active && lic.daysLeft === 1) {
        const serverDisplayName = await resolveServerDisplayName(lic);
        const ref = `lic_${lic.guild_id}_1d_${formatDateBR(lic.expires_at)}`;
        if (!(await db.wasNotified(ref))) {
          await sendUserAlert(
            lic.owner_id,
            `⏳ **Aviso de Aluguel do Robô — ${lic.store_name}**\n` +
            `Falta **1 dia** para o vencimento da licença do servidor **${serverDisplayName}**.\n` +
            `Entre em contato no Discord Oficial (${OFFICIAL_DISCORD}) para renovar.`
          );
          await db.markNotified(ref);
        }
      }
    }

    await refreshAllFixedPanels();
  } catch (err) {
    console.error('❌ Erro no worker 24h:', err);
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('[MASTER] Central administrativa fixa 24h e gestão completa')
    .addSubcommand(s => s.setName('painel_fixo').setDescription('Fixa o painel administrativo do Master neste canal (atualiza 24h)'))
    .addSubcommand(s =>
      s.setName('ativar')
        .setDescription('Ativa ou renova uma empresa/loja e avisa dono e servidor')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
        .addStringOption(o => o.setName('id_dono').setDescription('ID do Dono').setRequired(true))
        .addStringOption(o => o.setName('nome_empresa').setDescription('Nome da Empresa/Loja').setRequired(true))
        .addIntegerOption(o => o.setName('dias').setDescription('Dias de licença').setRequired(true))
        .addStringOption(o => o.setName('nome_servidor').setDescription('Nome do servidor para exibir na DM (opcional)').setRequired(false))
    )
    .addSubcommand(s => s.setName('clientes').setDescription('Lista todos os clientes (donos) e suas lojas'))
    .addSubcommand(s =>
      s.setName('remover_cliente')
        .setDescription('Remove um cliente e todas as lojas dele')
        .addStringOption(o => o.setName('id_dono').setDescription('ID do Dono').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('remover_loja')
        .setDescription('Remove uma loja específica')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('bloquear')
        .setDescription('Bloqueia um servidor com motivo e avisa o dono na DM')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
        .addStringOption(o => o.setName('motivo').setDescription('Motivo do bloqueio (exibido na DM do dono)').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('desbloquear')
        .setDescription('Desbloqueia um servidor')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
    )
    .addSubcommand(s => s.setName('logs').setDescription('Consulta logs administrativos de auditoria')),

  new SlashCommandBuilder()
    .setName('painel_dono')
    .setDescription('[DONO] Painel fixo 24h, planos, pedidos PIX, hospedagens e configurações')
    .addSubcommand(s => s.setName('painel_fixo').setDescription('Fixa o painel da sua empresa neste canal (atualiza 24h)'))
    .addSubcommand(s =>
      s.setName('config_pix')
        .setDescription('Define sua Chave PIX para receber pagamentos')
        .addStringOption(o => o.setName('chave_pix').setDescription('Sua chave PIX').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('foto_loja')
        .setDescription('Define a foto exclusiva da sua empresa apenas neste servidor')
        .addStringOption(o => o.setName('url_imagem').setDescription('Link da imagem (https://...) ou "remover"').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('canal_logs')
        .setDescription('Define o canal de logs de pedidos e hospedagens')
        .addChannelOption(o => o.setName('canal').setDescription('Canal de texto').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('manutencao')
        .setDescription('Ativa ou desativa modo manutenção da loja')
        .addBooleanOption(o => o.setName('ativo').setDescription('True para ativar manutenção').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('criar_plano')
        .setDescription('Cria plano de hospedagem e exibe o ID')
        .addStringOption(o => o.setName('nome').setDescription('Nome do plano').setRequired(true))
        .addNumberOption(o => o.setName('preco').setDescription('Preço em R$').setRequired(true))
        .addIntegerOption(o => o.setName('dias').setDescription('Duração em dias').setRequired(true))
        .addStringOption(o => o.setName('especificacoes').setDescription('RAM, CPU, SSD, detalhes').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('criar_cupom')
        .setDescription('Cria cupom de desconto para clientes')
        .addStringOption(o => o.setName('codigo').setDescription('Código do cupom').setRequired(true))
        .addIntegerOption(o => o.setName('desconto').setDescription('Porcentagem de desconto (1 a 95)').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('aprovar_pedido')
        .setDescription('Confirma PIX recebido e libera a hospedagem do cliente')
        .addStringOption(o => o.setName('codigo_pedido').setDescription('Código do pedido (ex: PED-00001)').setRequired(true))
        .addStringOption(o => o.setName('dados_acesso').setDescription('Link do painel, IP, usuário/senha').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('reembolsar_pedido')
        .setDescription('Marca pedido como reembolsado e suspende a hospedagem vinculada')
        .addStringOption(o => o.setName('codigo_pedido').setDescription('Código do pedido (ex: PED-00001)').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('gerenciar_hospedagem')
        .setDescription('Renova, suspende, reativa, transfere ou exclui uma hospedagem')
        .addStringOption(o => o.setName('codigo_hospedagem').setDescription('Código (ex: HOS-00001)').setRequired(true))
        .addStringOption(o =>
          o.setName('acao')
            .setDescription('Ação desejada')
            .setRequired(true)
            .addChoices(
              { name: 'Renovar +30 dias', value: 'renovar' },
              { name: 'Suspender', value: 'suspender' },
              { name: 'Reativar', value: 'reativar' },
              { name: 'Excluir', value: 'excluir' }
            )
        )
    )
    .addSubcommand(s =>
      s.setName('transferir_hospedagem')
        .setDescription('Transfere a titularidade de uma hospedagem para outro cliente')
        .addStringOption(o => o.setName('codigo_hospedagem').setDescription('Código (ex: HOS-00001)').setRequired(true))
        .addStringOption(o => o.setName('novo_dono_id').setDescription('ID do novo cliente no Discord').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('enviar_vitrine')
        .setDescription('Envia vitrine de compra de um plano neste canal')
        .addIntegerOption(o => o.setName('id_plano').setDescription('ID do plano').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('painel_ticket')
    .setDescription('[DONO/ADMIN] Fixa um painel permanente de tickets com categorias neste canal'),

  new SlashCommandBuilder()
    .setName('produtos')
    .setDescription('[DONO] Lista todos os planos com ID para editar ou remover'),

  new SlashCommandBuilder()
    .setName('painel')
    .setDescription('[CLIENTE] Abre seu painel fixo de hospedagem (atualiza automaticamente 24h)'),

  new SlashCommandBuilder()
    .setName('loja')
    .setDescription('[CLIENTE] Abre o catálogo de hospedagens disponíveis para contratar'),

  new SlashCommandBuilder()
    .setName('minhas_hospedagens')
    .setDescription('[CLIENTE] Lista todas as suas hospedagens, datas e status'),

  new SlashCommandBuilder()
    .setName('suporte')
    .setDescription('[CLIENTE] Abre um ticket privado de suporte com a equipe')
    .addStringOption(o =>
      o.setName('categoria')
        .setDescription('Categoria do atendimento')
        .setRequired(true)
        .addChoices(
          { name: 'Suporte Técnico', value: 'tecnico' },
          { name: 'Financeiro / PIX', value: 'financeiro' },
          { name: 'Vendas / Planos', value: 'vendas' }
        )
    )
].map(c => c.toJSON());

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN?.trim();
  const clientId = process.env.CLIENT_ID?.trim();
  if (!token || !clientId) return;
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Comandos registrados (Pacote Pro).');
  } catch (e) {
    console.error('❌ Erro ao registrar comandos:', e);
  }
}

let readyHandled = false;
let processingPaymentOutbox = false;

async function processPaymentOutbox() {
  if (processingPaymentOutbox || !client.isReady()) return;
  processingPaymentOutbox = true;
  try {
    const pending = await db.getPendingPaymentNotifications(20);
    for (const item of pending) {
      try {
        const order = await db.getOrderByCode(item.order_code);
        if (!order || order.status !== 'approved' || !order.hosting_code) continue;
        const hosting = await db.getHostingByCode(order.hosting_code);
        if (!hosting) continue;
        const license = await db.getLicense(order.guild_id);
        await notifyOrderApproved({
          order,
          hosting,
          alreadyApproved: false,
          renewed: Boolean(order.renewal_hosting_code)
        }, license?.store_name || 'Loja');
        await db.markPaymentNotificationProcessed(order.order_code);
      } catch (err) {
        console.error('Falha ao entregar notificação de pagamento:', item.order_code, err.message);
      }
    }
  } catch (err) {
    console.error('Falha ao consultar fila de notificações de pagamento:', err.message);
  } finally {
    processingPaymentOutbox = false;
  }
}

async function onBotReady() {
  if (readyHandled) return;
  readyHandled = true;
  console.log(`✅ Bot online como ${client.user.tag}`);
  if (process.env.REGISTER_COMMANDS === 'true') {
    await registerCommands();
  }
  await runScheduledChecks();
  setInterval(runScheduledChecks, 5 * 60 * 1000);
  await processPaymentOutbox();
  setInterval(processPaymentOutbox, 15 * 1000);
}

client.once('clientReady', onBotReady);
client.once('ready', onBotReady);

async function openTicketChannel(interaction, category) {
  const license = await db.getLicense(interaction.guildId);
  const channelName = `ticket-${category}-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);

  const overwrites = [
    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
  ];
  if (license?.owner_id) {
    overwrites.push({ id: license.owner_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
  }

  const ticketChannel = await interaction.guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites
  });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('close_ticket').setLabel('Fechar Ticket').setStyle(ButtonStyle.Danger)
  );

  await ticketChannel.send({
    content: `🎫 **Ticket Aberto — Categoria: ${category.toUpperCase()}**\nCliente: <@${interaction.user.id}>${license?.owner_id ? ` • Responsável: <@${license.owner_id}>` : ''}`,
    components: [closeRow]
  });

  return interaction.reply({ content: `✅ Ticket aberto em <#${ticketChannel.id}>!`, ephemeral: true });
}

async function buildProductsView(guildId) {
  const products = await db.getProductsByGuild(guildId);
  if (!products.length) {
    return {
      embed: new EmbedBuilder()
        .setTitle('📦 Planos de Hospedagem')
        .setDescription('Nenhum plano criado ainda. Use `/painel_dono criar_plano` para criar e ver o **ID**.')
        .setColor('#95a5a6'),
      components: []
    };
  }

  const lines = products.map(p =>
    `• **ID #${p.id}** — **${p.name}** | R$ ${Number(p.price).toFixed(2)} (${p.duration_days || 30}d)\n  _${p.specs || p.description}_`
  );

  const embed = new EmbedBuilder()
    .setTitle('📦 Gerenciador de Planos')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setColor('#3498db')
    .setFooter({ text: 'Selecione um plano abaixo para editar ou remover' });

  const options = products.slice(0, 25).map(p => ({
    label: `#${p.id} - ${p.name}`.slice(0, 100),
    description: `R$ ${Number(p.price).toFixed(2)} • ${p.duration_days || 30} dia(s)`.slice(0, 100),
    value: String(p.id)
  }));

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('prod_select')
      .setPlaceholder('Escolha um plano pelo ID...')
      .addOptions(options)
  );

  return { embed, components: [row] };
}

client.on('interactionCreate', async (interaction) => {
  try {
    const isMaster = interaction.user.id === process.env.MASTER_ID?.trim();

    // /ADMIN
    if (interaction.isChatInputCommand() && interaction.commandName === 'admin') {
      if (!isMaster) {
        return interaction.reply({ content: '⛔ Acesso negado. Comando exclusivo do Master.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();

      if (sub === 'painel_fixo') {
        const payload = await renderMasterFixedPanel();
        const msg = await interaction.channel.send(payload);
        await db.registerFixedPanel('master', interaction.guildId || 'global', interaction.user.id, interaction.channelId, msg.id);
        return interaction.reply({ content: '✅ Painel administrativo fixado neste canal! Ele atualiza automaticamente 24h.', ephemeral: true });
      }

      if (sub === 'ativar') {
        const guildId = interaction.options.getString('id_servidor').trim();
        const ownerId = interaction.options.getString('id_dono').trim();
        const storeName = interaction.options.getString('nome_empresa').trim();
        const days = interaction.options.getInteger('dias');
        const serverName = interaction.options.getString('nome_servidor')?.trim() || null;

        const lic = await db.upsertLicense(guildId, ownerId, storeName, days, serverName);
        await db.logAudit(guildId, interaction.user.id, 'ATIVAR_LICENCA', `${storeName} (${days}d) para ${ownerId}`);
        await notifyLicenseActivated(lic);
        await refreshAllFixedPanels();
        return interaction.reply({
          content: `✅ Empresa **${lic.store_name}** (Servidor: **${lic.server_name}**) ativada para <@${lic.owner_id}> por **${lic.daysLeft}d** e avisos enviados!`,
          ephemeral: true
        });
      }

      if (sub === 'clientes') {
        const all = await db.getAllLicenses();
        if (!all.length) return interaction.reply({ content: '📭 Nenhum cliente cadastrado.', ephemeral: true });
        const grouped = new Map();
        for (const l of all) {
          if (!grouped.has(l.owner_id)) grouped.set(l.owner_id, []);
          grouped.get(l.owner_id).push(l);
        }
        const text = Array.from(grouped.entries()).map(([oid, list]) => {
          const lines = list.map(s => `  ↳ **${s.store_name}** (${s.server_name}) — ${s.isOperational ? '🟢 Ativo' : '🔴 Inativo'} (${s.daysLeft}d)`).join('\n');
          return `👤 **Cliente:** <@${oid}> (\`${oid}\`)\n${lines}`;
        }).join('\n\n');
        return interaction.reply({
          embeds: [new EmbedBuilder().setTitle(`👥 Clientes Cadastrados (${grouped.size})`).setDescription(text.slice(0, 4000)).setColor('#3498db')],
          ephemeral: true
        });
      }

      if (sub === 'remover_cliente') {
        const oid = interaction.options.getString('id_dono').trim();
        const count = await db.deleteOwnerAndStores(oid);
        await db.logAudit('global', interaction.user.id, 'REMOVER_CLIENTE', `Dono ${oid} (${count} lojas)`);
        await refreshAllFixedPanels();
        return interaction.reply({ content: count ? `🗑️ Cliente \`${oid}\` e **${count} loja(s)** removidos!` : '❌ Cliente não encontrado.', ephemeral: true });
      }

      if (sub === 'remover_loja') {
        const gid = interaction.options.getString('id_servidor').trim();
        const ok = await db.deleteLicense(gid);
        await db.logAudit(gid, interaction.user.id, 'REMOVER_LOJA', `Servidor ${gid}`);
        await refreshAllFixedPanels();
        return interaction.reply({ content: ok ? `🗑️ Loja \`${gid}\` removida!` : '❌ Loja não encontrada.', ephemeral: true });
      }

      if (sub === 'bloquear') {
        const gid = interaction.options.getString('id_servidor').trim();
        const motivo = interaction.options.getString('motivo').trim();
        const lic = await db.setLicenseStatus(gid, false, motivo);
        if (!lic) return interaction.reply({ content: '❌ Servidor não encontrado.', ephemeral: true });
        await notifyLicenseBlocked(lic, motivo);
        await db.logAudit(gid, interaction.user.id, 'BLOQUEAR', `Motivo: ${motivo}`);
        await refreshAllFixedPanels();
        return interaction.reply({
          content: `🔒 Servidor **${lic.server_name}** bloqueado!\n📩 Dono avisado na DM com o motivo: **${motivo}**`,
          ephemeral: true
        });
      }

      if (sub === 'desbloquear') {
        const gid = interaction.options.getString('id_servidor').trim();
        const lic = await db.setLicenseStatus(gid, true, null);
        if (!lic) return interaction.reply({ content: '❌ Servidor não encontrado.', ephemeral: true });
        if (lic.isOperational) await notifyLicenseActivated(lic);
        await db.logAudit(gid, interaction.user.id, 'DESBLOQUEAR', gid);
        await refreshAllFixedPanels();
        return interaction.reply({ content: `🔓 Desbloqueado: **${lic.server_name}**`, ephemeral: true });
      }

      if (sub === 'logs') {
        const logs = await db.getAuditLogs(15);
        const text = logs.map(l => `• \`${formatDateBR(l.created_at)}\` **${l.action}** por <@${l.actor_id}>: ${l.details}`).join('\n') || 'Sem registros.';
        return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🛡️ Logs Administrativos').setDescription(text.slice(0, 4000)).setColor('#95a5a6')], ephemeral: true });
      }
    }

    // BOTÕES DO PAINEL FIXO MASTER
    if (interaction.isButton() && interaction.customId.startsWith('fp_')) {
      if (interaction.customId === 'fp_refresh_master') {
        if (!isMaster) return interaction.reply({ content: '⛔ Exclusivo do Master.', ephemeral: true });
        await interaction.update(await renderMasterFixedPanel());
        return;
      }
      if (interaction.customId === 'fp_master_clients') {
        if (!isMaster) return interaction.reply({ content: '⛔ Exclusivo do Master.', ephemeral: true });
        const all = await db.getAllLicenses();
        const text = all.map(l => `• **${l.store_name}** (${l.server_name}) — Dono: <@${l.owner_id}> | ${l.daysLeft}d`).join('\n') || 'Nenhum cliente.';
        return interaction.reply({ content: text.slice(0, 1900), ephemeral: true });
      }
      if (interaction.customId === 'fp_master_pending') {
        if (!isMaster) return interaction.reply({ content: '⛔ Exclusivo do Master.', ephemeral: true });
        const m = await db.getGlobalMetrics();
        const pend = m.orders.filter(o => o.status === 'pending').slice(0, 15);
        const text = pend.map(o => `• **${o.order_code}** | <@${o.customer_id}> | R$ ${Number(o.final_price).toFixed(2)}`).join('\n') || 'Nenhum pedido pendente.';
        return interaction.reply({ content: text.slice(0, 1900), ephemeral: true });
      }
    }

    if (interaction.isButton() && interaction.customId.startsWith('rate_')) {
      const stars = Number(interaction.customId.slice('rate_'.length));
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) return interaction.reply({ content: '❌ Avaliação inválida.', ephemeral: true });
      await db.addReview('global', interaction.user.id, stars);
      return interaction.reply({ content: '✅ Obrigado pela sua avaliação de **' + stars + ' estrela(s)**!', ephemeral: true });
    }

    if (!interaction.guildId) return;
    const license = await db.getLicense(interaction.guildId);

    // /PAINEL_TICKET (PODE SER FIXADO POR DONO OU MASTER)
    if (interaction.isChatInputCommand() && interaction.commandName === 'painel_ticket') {
      if (!isMaster && interaction.user.id !== license?.owner_id) {
        return interaction.reply({ content: '⛔ Apenas o dono da loja ou Master pode fixar o painel de tickets.', ephemeral: true });
      }
      const storeName = license?.store_name || interaction.guild.name;
      const storePhoto = license?.store_photo || null;
      const payload = renderTicketFixedPanel(storeName, storePhoto);
      const msg = await interaction.channel.send(payload);
      await db.registerFixedPanel('ticket', interaction.guildId, license?.owner_id || interaction.user.id, interaction.channelId, msg.id);
      return interaction.reply({ content: '✅ Painel de tickets fixo com categorias criado neste canal!', ephemeral: true });
    }

    // BOTÕES DE ABRIR TICKET POR CATEGORIA
    if (interaction.isButton() && interaction.customId.startsWith('open_ticket_')) {
      const category = interaction.customId.replace('open_ticket_', '');
      return openTicketChannel(interaction, category);
    }

    if (!license || (!license.isOperational && interaction.user.id !== license.owner_id && !isMaster)) {
      if (interaction.isRepliable()) {
        return interaction.reply({
          content: license?.maintenance ? '🛠️ **Empresa em manutenção programada.** Tente novamente em breve.' : LOCKED_MSG,
          ephemeral: true
        });
      }
      return;
    }

    // /PAINEL_DONO
    if (interaction.isChatInputCommand() && interaction.commandName === 'painel_dono') {
      if (interaction.user.id !== license.owner_id && !isMaster) {
        return interaction.reply({ content: '⛔ Apenas o dono registrado desta empresa pode usar este comando.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();

      if (sub === 'painel_fixo') {
        const payload = await renderOwnerFixedPanel(interaction.guildId);
        const msg = await interaction.channel.send(payload);
        await db.registerFixedPanel('owner', interaction.guildId, license.owner_id, interaction.channelId, msg.id);
        return interaction.reply({ content: '✅ Painel fixo da empresa criado! Ele atualiza automaticamente 24h.', ephemeral: true });
      }

      if (sub === 'config_pix') {
        const key = interaction.options.getString('chave_pix').trim();
        await db.updateLicenseDetails(interaction.guildId, { pixKey: key });
        await db.logAudit(interaction.guildId, interaction.user.id, 'CONFIG_PIX', 'Chave PIX atualizada');
        await refreshAllFixedPanels();
        return interaction.reply({ content: `✅ Chave PIX definida como \`${key}\`!`, ephemeral: true });
      }

      if (sub === 'foto_loja') {
        const url = interaction.options.getString('url_imagem').trim();
        if (url.toLowerCase() === 'remover') {
          await db.updateLicenseDetails(interaction.guildId, { storePhoto: null });
          await refreshAllFixedPanels();
          return interaction.reply({ content: '🗑️ Foto exclusiva removida.', ephemeral: true });
        }
        if (!isValidImageUrl(url)) return interaction.reply({ content: '❌ URL inválida.', ephemeral: true });
        await db.updateLicenseDetails(interaction.guildId, { storePhoto: url });
        await refreshAllFixedPanels();
        return interaction.reply({ content: '✅ Foto exclusiva salva! Aparecerá apenas nas vitrines e painéis deste servidor.', ephemeral: true });
      }

      if (sub === 'canal_logs') {
        const ch = interaction.options.getChannel('canal');
        await db.updateLicenseDetails(interaction.guildId, { logsChannelId: ch.id });
        return interaction.reply({ content: `✅ Canal de logs definido para <#${ch.id}>.`, ephemeral: true });
      }

      if (sub === 'manutencao') {
        const ativo = interaction.options.getBoolean('ativo');
        await db.updateLicenseDetails(interaction.guildId, { maintenance: ativo });
        await refreshAllFixedPanels();
        return interaction.reply({ content: ativo ? '🛠️ Modo manutenção ATIVADO.' : '🟢 Modo manutenção DESATIVADO.', ephemeral: true });
      }

      if (sub === 'criar_plano') {
        const nome = interaction.options.getString('nome').trim();
        const preco = interaction.options.getNumber('preco');
        const dias = interaction.options.getInteger('dias');
        const specs = interaction.options.getString('especificacoes').trim();
        const info = await db.addProduct(interaction.guildId, nome, specs, preco, dias, specs);
        await refreshAllFixedPanels();
        return interaction.reply({
          content: `✅ Plano **${nome}** criado!\n🆔 **ID do Plano:** **#${info.id}**\n💵 **Valor:** R$ ${preco.toFixed(2)} por **${dias} dia(s)**`,
          ephemeral: true
        });
      }

      if (sub === 'criar_cupom') {
        const codigo = interaction.options.getString('codigo').trim().toUpperCase();
        const desconto = interaction.options.getInteger('desconto');
        const c = await db.createCoupon(interaction.guildId, codigo, desconto);
        return interaction.reply({ content: `🎟️ Cupom **${c.code}** (${c.discount_percent}% OFF) criado!`, ephemeral: true });
      }

      if (sub === 'aprovar_pedido') {
        const orderCode = interaction.options.getString('codigo_pedido').trim().toUpperCase();
        const accessInfo = interaction.options.getString('dados_acesso').trim();
        const existing = await db.getOrderByCode(orderCode);
        if (!existing || existing.guild_id !== interaction.guildId) {
          return interaction.reply({ content: `❌ Pedido **${orderCode}** não encontrado nesta loja.`, ephemeral: true });
        }
        if (existing.status === 'approved') {
          return interaction.reply({ content: `✅ O pedido **${orderCode}** já foi aprovado e está vinculado à hospedagem **${existing.hosting_code || 'existente'}**.`, ephemeral: true });
        }
        if (existing.status !== 'pending') {
          return interaction.reply({ content: `❌ O pedido **${orderCode}** não está pendente (status: ${existing.status}).`, ephemeral: true });
        }
        if (existing.payment_provider === 'mercadopago' && existing.payment_status !== 'approved') {
          return interaction.reply({ content: '⛔ Este pedido só pode ser liberado após a confirmação automática do Mercado Pago.', ephemeral: true });
        }

        const result = await db.approveOrderAndCreateHosting(orderCode, accessInfo);
        if (!result) {
          return interaction.reply({ content: '❌ Não foi possível aprovar o pedido. Atualize a lista e confira o status.', ephemeral: true });
        }
        if (result.alreadyApproved) {
          return interaction.reply({ content: `✅ O pedido **${orderCode}** já estava aprovado.`, ephemeral: true });
        }
        await db.logAudit(interaction.guildId, interaction.user.id, 'APROVAR_PEDIDO', `${orderCode} -> ${result.hosting.code}`);

        await notifyOrderApproved(result, license.store_name);

        await refreshAllFixedPanels();
        return interaction.reply({
          content: `✅ Pedido **${orderCode}** aprovado! Hospedagem **${result.hosting.code}** criada e enviada na DM de <@${result.order.customer_id}>.`,
          ephemeral: true
        });
      }

      if (sub === 'reembolsar_pedido') {
        const orderCode = interaction.options.getString('codigo_pedido').trim().toUpperCase();
        const existing = await db.getOrderByCode(orderCode);
        if (!existing || existing.guild_id !== interaction.guildId) {
          return interaction.reply({ content: `❌ Pedido **${orderCode}** não encontrado nesta loja.`, ephemeral: true });
        }
        const refunded = await db.refundOrder(orderCode);
        await db.logAudit(interaction.guildId, interaction.user.id, 'REEMBOLSAR_PEDIDO', orderCode);
        await sendUserAlert(refunded.customer_id, `💸 **Reembolso Registrado — ${orderCode}**\nSeu pedido foi reembolsado e a hospedagem vinculada (se houver) foi suspensa.`);
        await refreshAllFixedPanels();
        return interaction.reply({ content: `💸 Pedido **${orderCode}** marcado como reembolsado.`, ephemeral: true });
      }

      if (sub === 'gerenciar_hospedagem') {
        const hosCode = interaction.options.getString('codigo_hospedagem').trim().toUpperCase();
        const acao = interaction.options.getString('acao');
        const hos = await db.getHostingByCode(hosCode);
        if (!hos || hos.guild_id !== interaction.guildId) {
          return interaction.reply({ content: `❌ Hospedagem **${hosCode}** não encontrada nesta loja.`, ephemeral: true });
        }

        if (acao === 'renovar') {
          const updated = await db.renewHosting(hosCode, 30);
          await sendUserAlert(hos.customer_id, `✅ Sua hospedagem **${hosCode}** foi renovada por +30 dias! Novo vencimento: ${formatDateBR(updated.expires_at)}.`);
          await refreshAllFixedPanels();
          return interaction.reply({ content: `✅ **${hosCode}** renovada por +30 dias!`, ephemeral: true });
        }
        if (acao === 'suspender') {
          await db.updateHostingStatus(hosCode, 'suspended');
          await sendUserAlert(hos.customer_id, `🔴 Sua hospedagem **${hosCode}** foi suspensa pela administração.`);
          await refreshAllFixedPanels();
          return interaction.reply({ content: `🔒 **${hosCode}** suspensa.`, ephemeral: true });
        }
        if (acao === 'reativar') {
          await db.updateHostingStatus(hosCode, 'active');
          await sendUserAlert(hos.customer_id, `🟢 Sua hospedagem **${hosCode}** foi reativada!`);
          await refreshAllFixedPanels();
          return interaction.reply({ content: `🔓 **${hosCode}** reativada.`, ephemeral: true });
        }
        if (acao === 'excluir') {
          await db.deleteHosting(hosCode);
          await refreshAllFixedPanels();
          return interaction.reply({ content: `🗑️ **${hosCode}** excluída.`, ephemeral: true });
        }
      }

      if (sub === 'transferir_hospedagem') {
        const hosCode = interaction.options.getString('codigo_hospedagem').trim().toUpperCase();
        const newOwnerId = interaction.options.getString('novo_dono_id').trim();
        const hos = await db.getHostingByCode(hosCode);
        if (!hos || hos.guild_id !== interaction.guildId) {
          return interaction.reply({ content: `❌ Hospedagem **${hosCode}** não encontrada.`, ephemeral: true });
        }
        await db.transferHostingOwner(hosCode, newOwnerId);
        await sendUserAlert(newOwnerId, `🔄 **Titularidade Transferida — ${hosCode}**\nVocê agora é o titular da hospedagem **${hos.plan_name}** na loja **${license.store_name}**.`);
        await refreshAllFixedPanels();
        return interaction.reply({ content: `✅ Hospedagem **${hosCode}** transferida para <@${newOwnerId}>!`, ephemeral: true });
      }

      if (sub === 'enviar_vitrine') {
        const prodId = interaction.options.getInteger('id_plano');
        const prod = await db.getProduct(prodId, interaction.guildId);
        if (!prod) return interaction.reply({ content: `❌ Plano **#${prodId}** não encontrado.`, ephemeral: true });

        const embed = new EmbedBuilder()
          .setTitle(`🖥️ ${license.store_name} — ${prod.name}`)
          .setDescription(prod.specs || prod.description)
          .addFields(
            { name: '🆔 ID', value: `#${prod.id}`, inline: true },
            { name: '💵 Valor', value: `R$ ${Number(prod.price).toFixed(2)}`, inline: true },
            { name: '⏳ Ciclo', value: `${prod.duration_days || 30} dia(s)`, inline: true }
          )
          .setColor('#2ecc71')
          .setFooter({ text: 'Clique abaixo para contratar via PIX • Suporte e painel 24h' });

        if (license.store_photo && isValidImageUrl(license.store_photo)) {
          embed.setImage(license.store_photo);
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`comprar_${prod.id}`).setLabel('Contratar Agora').setStyle(ButtonStyle.Success)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: `✅ Vitrine do plano **#${prod.id}** enviada!`, ephemeral: true });
      }
    }

    // BOTÕES DO PAINEL FIXO DO DONO
    if (interaction.isButton() && interaction.customId.startsWith('fp_')) {
      if (interaction.customId === 'fp_refresh_owner') {
        if (interaction.user.id !== license.owner_id && !isMaster) return interaction.reply({ content: '⛔ Exclusivo do dono.', ephemeral: true });
        await interaction.update(await renderOwnerFixedPanel(interaction.guildId));
        return;
      }
      if (interaction.customId === 'fp_owner_orders') {
        if (interaction.user.id !== license.owner_id && !isMaster) return interaction.reply({ content: '⛔ Exclusivo do dono.', ephemeral: true });
        const orders = (await db.getOrdersByGuild(interaction.guildId)).filter(o => o.status === 'pending');
        const text = orders.map(o => `• **${o.order_code}** — <@${o.customer_id}> | **${o.plan_name}** | R$ ${Number(o.final_price).toFixed(2)}`).join('\n') || 'Nenhum pedido aguardando aprovação.';
        return interaction.reply({ content: `⏳ **Pedidos Aguardando PIX:**\n${text}`.slice(0, 1950), ephemeral: true });
      }
      if (interaction.customId === 'fp_owner_hostings') {
        if (interaction.user.id !== license.owner_id && !isMaster) return interaction.reply({ content: '⛔ Exclusivo do dono.', ephemeral: true });
        const hostings = await db.getHostingsByGuild(interaction.guildId);
        const text = hostings.slice(0, 20).map(h => `• **${h.code}** — <@${h.customer_id}> | ${h.plan_name} | ${h.status === 'active' ? '🟢 Ativo' : '🔴 Suspenso'} (${h.daysLeft}d)`).join('\n') || 'Nenhuma hospedagem.';
        return interaction.reply({ content: text.slice(0, 1950), ephemeral: true });
      }
    }

    // /PRODUTOS
    if (interaction.isChatInputCommand() && interaction.commandName === 'produtos') {
      if (interaction.user.id !== license.owner_id && !isMaster) {
        return interaction.reply({ content: '⛔ Apenas o dono pode gerenciar planos.', ephemeral: true });
      }
      const view = await buildProductsView(interaction.guildId);
      return interaction.reply({ embeds: [view.embed], components: view.components, ephemeral: true });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'prod_select') {
      if (interaction.user.id !== license.owner_id && !isMaster) return interaction.reply({ content: '⛔ Apenas o dono da loja pode editar planos.', ephemeral: true });
      const prodId = parseInt(interaction.values[0], 10);
      const prod = await db.getProduct(prodId, interaction.guildId);
      if (!prod) return interaction.reply({ content: '❌ Plano não encontrado.', ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle(`🛠️ Plano #${prod.id} — ${prod.name}`)
        .setDescription(prod.specs || prod.description)
        .addFields(
          { name: '🆔 ID', value: `#${prod.id}`, inline: true },
          { name: '💵 Preço', value: `R$ ${Number(prod.price).toFixed(2)}`, inline: true },
          { name: '⏳ Dias', value: `${prod.duration_days || 30}d`, inline: true }
        )
        .setColor('#e67e22');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`prod_edit_${prod.id}`).setLabel('Editar').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`prod_del_${prod.id}`).setLabel('Remover').setStyle(ButtonStyle.Danger)
      );
      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('prod_edit_')) {
      if (interaction.user.id !== license.owner_id && !isMaster) return interaction.reply({ content: '⛔ Apenas o dono da loja pode editar planos.', ephemeral: true });
      const prodId = parseInt(interaction.customId.replace('prod_edit_', ''), 10);
      const prod = await db.getProduct(prodId, interaction.guildId);
      if (!prod) return interaction.reply({ content: '❌ Plano não encontrado.', ephemeral: true });

      const modal = new ModalBuilder().setCustomId(`prod_modal_${prod.id}`).setTitle(`Editar Plano #${prod.id}`);
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('nome').setLabel('Nome do plano').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(prod.name).slice(0, 100))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('preco').setLabel('Preço em R$').setStyle(TextInputStyle.Short).setRequired(true).setValue(String(Number(prod.price)))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('specs').setLabel('Especificações / Descrição').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(String(prod.specs || prod.description).slice(0, 1000)))
      );
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('prod_modal_')) {
      if (interaction.user.id !== license.owner_id && !isMaster) return interaction.reply({ content: '⛔ Apenas o dono da loja pode editar planos.', ephemeral: true });
      const prodId = parseInt(interaction.customId.replace('prod_modal_', ''), 10);
      const nome = interaction.fields.getTextInputValue('nome').trim();
      const preco = Number(interaction.fields.getTextInputValue('preco').replace(',', '.').trim());
      const specs = interaction.fields.getTextInputValue('specs').trim();
      if (Number.isNaN(preco) || preco <= 0) return interaction.reply({ content: '❌ Preço inválido.', ephemeral: true });

      const updated = await db.updateProduct(prodId, interaction.guildId, { name: nome, price: preco, description: specs, specs });
      await refreshAllFixedPanels();
      return interaction.reply({ content: `✅ Plano **#${updated.id}** (**${updated.name}**) atualizado!`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId.startsWith('prod_del_')) {
      if (interaction.user.id !== license.owner_id && !isMaster) return interaction.reply({ content: '⛔ Apenas o dono da loja pode remover planos.', ephemeral: true });
      const prodId = parseInt(interaction.customId.replace('prod_del_', ''), 10);
      const ok = await db.deleteProduct(prodId, interaction.guildId);
      await refreshAllFixedPanels();
      return interaction.reply({ content: ok ? `🗑️ Plano **#${prodId}** removido!` : '❌ Não encontrado.', ephemeral: true });
    }

    // COMANDOS DO CLIENTE FINAL
    if (interaction.isChatInputCommand() && interaction.commandName === 'painel') {
      const payload = await renderCustomerFixedPanel(interaction.guildId, interaction.user.id);
      const msg = await interaction.channel.send(payload);
      await db.registerFixedPanel('customer', interaction.guildId, interaction.user.id, interaction.channelId, msg.id);
      return interaction.reply({ content: '✅ Seu painel fixo de hospedagem foi aberto neste canal e atualiza automaticamente 24h!', ephemeral: true });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'loja') {
      const products = await db.getProductsByGuild(interaction.guildId);
      if (!products.length) return interaction.reply({ content: '📭 Nenhum plano disponível no momento.', ephemeral: true });

      const desc = products.map(p => `• **#${p.id} — ${p.name}** (**R$ ${Number(p.price).toFixed(2)}** / ${p.duration_days || 30}d)\n  ${p.specs || p.description}`).join('\n\n');
      const embed = new EmbedBuilder().setTitle(`🛒 Catálogo de Hospedagens — ${license.store_name}`).setDescription(desc.slice(0, 4000)).setColor('#2ecc71');
      if (license.store_photo && isValidImageUrl(license.store_photo)) embed.setThumbnail(license.store_photo);

      const options = products.slice(0, 25).map(p => ({
        label: `${p.name} - R$ ${Number(p.price).toFixed(2)}`.slice(0, 100),
        description: `${p.duration_days || 30} dias`.slice(0, 100),
        value: String(p.id)
      }));

      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('loja_select_plan').setPlaceholder('Selecione um plano para contratar...').addOptions(options)
      );
      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'minhas_hospedagens') {
      const list = await db.getHostingsByCustomer(interaction.user.id, interaction.guildId);
      if (!list.length) return interaction.reply({ content: '📭 Você ainda não possui hospedagens ativas neste servidor.', ephemeral: true });
      const text = list.map(h =>
        `• **${h.code}** — **${h.plan_name}** | ${h.status === 'active' ? '🟢 Ativo' : '🔴 Suspenso'} | Vence em **${formatDateBR(h.expires_at)}** (${h.daysLeft}d)`
      ).join('\n');
      return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🖥️ Minhas Hospedagens').setDescription(text.slice(0, 4000)).setColor('#3498db')], ephemeral: true });
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'suporte') {
      const cat = interaction.options.getString('categoria');
      return openTicketChannel(interaction, cat);
    }

    if (interaction.isButton() && interaction.customId === 'close_ticket') {
      const rateRow = new ActionRowBuilder().addComponents(
        ...[1, 2, 3, 4, 5].map(n =>
          new ButtonBuilder().setCustomId(`rate_${n}`).setLabel(`${n}★`).setStyle(ButtonStyle.Secondary)
        )
      );
      await sendUserAlert(interaction.user.id, {
        content: `⭐ **Avalie o atendimento da loja ${license.store_name}:**`,
        components: [rateRow]
      });
      await interaction.reply({ content: '🔒 Fechando ticket em 3 segundos...' });
      setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
      return;
    }

    // BOTÕES DO PAINEL FIXO DO CLIENTE
    if (interaction.isButton() && interaction.customId.startsWith('fp_cust_')) {
      const parts = interaction.customId.split('_');
      const action = parts[2];
      const ownerOfPanel = parts[3];
      const hostingCode = parts.slice(4).join('_');

      if (interaction.user.id !== ownerOfPanel && interaction.user.id !== license.owner_id && !isMaster) {
        return interaction.reply({ content: '⛔ Este painel pertence a outro cliente.', ephemeral: true });
      }

      if (action === 'refresh') {
        await interaction.update(await renderCustomerFixedPanel(interaction.guildId, ownerOfPanel));
        return;
      }

      if (action === 'invoices') {
        const orders = await db.getOrdersByCustomer(ownerOfPanel, interaction.guildId);
        const text = orders.slice(0, 15).map(o =>
          `• **${o.order_code}** — ${o.plan_name} | R$ ${Number(o.final_price).toFixed(2)} | Status: **${o.status.toUpperCase()}**`
        ).join('\n') || 'Nenhuma fatura encontrada.';
        return interaction.reply({ content: `🧾 **Histórico de Faturas:**\n${text}`.slice(0, 1950), ephemeral: true });
      }

      if (action === 'renew') {
        if (!hostingCode || hostingCode === 'none') {
          return interaction.reply({ content: '❌ Não há hospedagem selecionada para renovar. Atualize seu painel.', ephemeral: true });
        }
        if (!await db.getMercadoPagoConnectionStatus(interaction.guildId)) {
          return interaction.reply({ content: '⛔ Esta loja ainda não conectou o Mercado Pago. O responsável deve conectar a conta no painel da loja antes de receber pagamentos.', ephemeral: true });
        }
        const order = await db.createRenewalOrder(interaction.guildId, ownerOfPanel, hostingCode);
        if (!order) {
          return interaction.reply({ content: '❌ Não foi possível gerar a renovação desta hospedagem. Atualize o painel e tente novamente.', ephemeral: true });
        }
        try {
          const checkout = await mp.createCheckoutPreference(order, db);
          await refreshAllFixedPanels();
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Pagar com Mercado Pago').setStyle(ButtonStyle.Link).setURL(checkout.paymentUrl)
          );
          return interaction.reply({
            content: '🔄 **Renovação gerada: ' + order.order_code + '**\\n' +
              '🖥️ **Hospedagem:** ' + hostingCode + '\\n' +
              '💵 **Valor:** R$ ' + Number(order.final_price).toFixed(2) + '\\n' +
              'O pagamento será confirmado automaticamente. Não envie comprovante nem compartilhe dados bancários.',
            components: [row],
            ephemeral: true
          });
        } catch (err) {
          console.error('Falha ao criar checkout de renovação:', err.message);
          return interaction.reply({ content: '❌ Não foi possível gerar o checkout agora. Nenhum pagamento foi confirmado; tente novamente mais tarde ou fale com o responsável pela loja.', ephemeral: true });
        }
      }
      if (action === 'support') {
        return interaction.reply({ content: '🎫 Use `/suporte` ou clique no painel de tickets para abrir atendimento!', ephemeral: true });
      }
    }

    // CONTRATAÇÃO DE PLANO
    if ((interaction.isButton() && interaction.customId.startsWith('comprar_')) || (interaction.isStringSelectMenu() && interaction.customId === 'loja_select_plan')) {
      const prodId = interaction.isButton() ? parseInt(interaction.customId.split('_')[1], 10) : parseInt(interaction.values[0], 10);
      const prod = await db.getProduct(prodId, interaction.guildId);
      if (!prod) return interaction.reply({ content: '❌ Plano indisponível.', ephemeral: true });

      const modal = new ModalBuilder().setCustomId(`checkout_modal_${prod.id}`).setTitle(`Contratar: ${String(prod.name).slice(0, 32)}`);
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('cupom')
            .setLabel('Cupom de desconto (opcional)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('Ex: PROMO10')
        )
      );
      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('checkout_modal_')) {
      const prodId = parseInt(interaction.customId.replace('checkout_modal_', ''), 10);
      const prod = await db.getProduct(prodId, interaction.guildId);
      if (!prod) return interaction.reply({ content: '❌ Plano não encontrado.', ephemeral: true });

      const cupom = interaction.fields.getTextInputValue('cupom')?.trim() || null;
      if (!await db.getMercadoPagoConnectionStatus(interaction.guildId)) {
        return interaction.reply({ content: '⛔ Esta loja ainda não conectou o Mercado Pago. O responsável pela loja precisa conectar a conta antes de receber pedidos.', ephemeral: true });
      }
      const order = await db.createOrder(interaction.guildId, interaction.user.id, prod, cupom);
      try {
        const paymentCheckout = await mp.createCheckoutPreference(order, db);
        await sendUserAlert(
          license.owner_id,
          '🔔 **Novo pedido — ' + license.store_name + '**\\n' +
          '• **Pedido:** ' + order.order_code + '\\n' +
          '• **Cliente:** <@' + interaction.user.id + '>\\n' +
          '• **Plano:** ' + order.plan_name + '\\n' +
          '• **Valor:** R$ ' + Number(order.final_price).toFixed(2) + '\\n' +
          'O checkout foi criado na conta Mercado Pago conectada.'
        );
        if (license.logs_channel_id) {
          const logCh = interaction.guild.channels.cache.get(license.logs_channel_id);
          if (logCh && logCh.isTextBased()) {
            await logCh.send('🧾 Pedido ' + order.order_code + ' criado para <@' + interaction.user.id + '> — R$ ' + Number(order.final_price).toFixed(2)).catch(() => {});
          }
        }
        await refreshAllFixedPanels();
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Pagar com Mercado Pago').setStyle(ButtonStyle.Link).setURL(paymentCheckout.paymentUrl)
        );
        const embed = new EmbedBuilder()
          .setTitle('🧾 Pedido criado — ' + order.order_code)
          .setDescription(
            'Seu pedido foi registrado. Use o botão abaixo para pagar na conta Mercado Pago da loja.\\n\\n' +
            '💵 **Valor:** R$ ' + Number(order.final_price).toFixed(2) + '\\n' +
            '📦 **Plano:** ' + order.plan_name + ' (' + order.duration_days + ' dias)\\n' +
            '🆔 **Pedido:** ' + order.order_code + '\\n\\n' +
            'A hospedagem será liberada somente após a confirmação do pagamento pelo Mercado Pago.'
          )
          .setColor('#00b0f4');
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
      } catch (err) {
        console.error('Falha ao criar checkout Mercado Pago:', err.message);
        return interaction.reply({ content: '❌ Não foi possível gerar o checkout. Nenhum pagamento foi confirmado. Tente novamente mais tarde ou fale com o responsável pela loja.', ephemeral: true });
      }
    }
  } catch (err) {
    console.error('❌ Erro na interação:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erro ao processar solicitação.', ephemeral: true }).catch(() => {});
    }
  }
});

async function notifyOrderApproved(result, storeName = 'Hospedagem') {
  if (!result?.order || !result?.hosting || result.alreadyApproved) return false;

  const hosting = result.hosting;
  const message = (result.renewed
    ? '🔄 **Renovação Confirmada!**'
    : '🎉 **Pagamento Confirmado & Hospedagem Ativa!**') + '\n\n' +
    '🏢 **Empresa:** ' + String(storeName) + '\n' +
    '🧾 **Pedido:** ' + String(result.order.order_code) + '\n' +
    '🆔 **Hospedagem:** ' + String(hosting.code) + '\n' +
    '📦 **Plano:** ' + String(hosting.plan_name) + '\n' +
    '⏳ **Vencimento:** ' + formatDateBR(hosting.expires_at) + ' (' + hosting.daysLeft + 'd)\n' +
    (result.renewed ? '' : '🔑 **Dados de acesso:**\n\u0060\u0060\u0060\n' + String(hosting.access_info || 'Consulte o suporte') + '\n\u0060\u0060\u0060');

  await sendUserAlert(result.order.customer_id, message);
  return true;
}

async function startBot() {
  const token = process.env.DISCORD_TOKEN?.trim();
  const masterId = process.env.MASTER_ID?.trim();
  const clientId = process.env.CLIENT_ID?.trim();
  if (!token) throw new Error('DISCORD_TOKEN ausente.');
  if (!masterId || !/^\d{17,20}$/.test(masterId)) throw new Error('MASTER_ID ausente ou inválido.');
  if (process.env.REGISTER_COMMANDS === 'true' && !clientId) throw new Error('CLIENT_ID é obrigatório quando REGISTER_COMMANDS=true.');
  console.log('🔄 Tentando conectar ao Discord...');
  await client.login(token);
}

module.exports = { startBot, client, notifyLicenseActivated, notifyLicenseBlocked, notifyOrderApproved, refreshAllFixedPanels };
