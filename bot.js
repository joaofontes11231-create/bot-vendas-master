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
const { MercadoPagoConfig, Payment } = require('mercadopago');
const db = require('./database');

const OFFICIAL_DISCORD = 'https://discord.gg/ZQzv7U3Vnw';

const LOCKED_MSG =
  `🤖 **Robô de Vendas Automáticas**\n` +
  `• **Estado do Robô:** 🔴 Desligado (Aguardando ativação)\n` +
  `• **Discord Oficial:** ${OFFICIAL_DISCORD}\n` +
  `*Entre em contato no servidor oficial para ativar o sistema.*`;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.on('error', (err) => console.error('❌ Erro no client:', err));
client.on('shardError', (err) => console.error('❌ Erro de shard/WebSocket:', err));

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

async function notifyLicenseActivated(license) {
  if (!license) return;

  const guild = client.guilds.cache.get(license.guild_id) || (await client.guilds.fetch(license.guild_id).catch(() => null));
  const guildName = guild ? guild.name : license.guild_id;

  const dmText =
    `✅ **Robô de Vendas Automáticas Ativado!**\n\n` +
    `🏪 **Loja:** ${license.store_name}\n` +
    `🖥️ **Servidor:** ${guildName} (\`${license.guild_id}\`)\n` +
    `⚡ **Estado do Robô:** 🟢 Ligado / Ativo\n` +
    `⏳ **Prazo:** **${license.daysLeft} dia(s)**\n` +
    `💬 **Discord Oficial:** ${OFFICIAL_DISCORD}`;

  try {
    const ownerUser = await client.users.fetch(license.owner_id);
    if (ownerUser) {
      await ownerUser.send(dmText);
    }
  } catch (err) {
    console.warn('⚠️ Não foi possível enviar DM para o dono:', err.message);
  }

  if (guild) {
    const channel = await findMainTextChannel(guild);
    if (channel) {
      await channel.send(
        `🟢 **Robô de Vendas Automáticas Ligado!**\n` +
        `• **Loja:** **${license.store_name}**\n` +
        `• **Dono:** <@${license.owner_id}>\n` +
        `• **Duração:** **${license.daysLeft} dia(s)**\n` +
        `• **Discord Oficial:** ${OFFICIAL_DISCORD}`
      ).catch(err => console.warn('⚠️ Sem permissão para avisar no canal do servidor:', err.message));
    }
  }
}

client.on('guildCreate', async (guild) => {
  try {
    const ch = await findMainTextChannel(guild);
    if (ch) await ch.send(LOCKED_MSG);
  } catch (err) {
    console.error('❌ Erro ao enviar aviso inicial:', err);
  }
});

const commands = [
  new SlashCommandBuilder()
    .setName('master')
    .setDescription('[MASTER] Gerenciar aluguéis, bloqueios e painel geral')
    .addSubcommand(s =>
      s.setName('ativar')
        .setDescription('Ativa ou renova uma loja e notifica dono e servidor')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
        .addStringOption(o => o.setName('id_dono').setDescription('ID da Conta do Dono').setRequired(true))
        .addStringOption(o => o.setName('nome_loja').setDescription('Nome da Loja').setRequired(true))
        .addIntegerOption(o => o.setName('dias').setDescription('Dias de aluguel').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('bloquear')
        .setDescription('Bloqueia imediatamente um servidor')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('desbloquear')
        .setDescription('Desbloqueia um servidor')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('status')
        .setDescription('Consulta dias restantes e status de um servidor')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('painel')
        .setDescription('Painel completo do Master com resumo das lojas')
    ),

  new SlashCommandBuilder()
    .setName('painel_dono')
    .setDescription('[DONO] Gerencia loja, foto exclusiva, PIX, estoque e vitrine')
    .addSubcommand(s => s.setName('painel').setDescription('Painel completo da sua loja com todas as informações'))
    .addSubcommand(s => s.setName('aluguel').setDescription('Dias restantes do aluguel'))
    .addSubcommand(s =>
      s.setName('foto_loja')
        .setDescription('Define a foto/imagem exclusiva da sua loja neste servidor')
        .addStringOption(o => o.setName('url_imagem').setDescription('Link direto da imagem (https://...) ou "remover"').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('config_pix')
        .setDescription('Configura seu Access Token do Mercado Pago')
        .addStringOption(o => o.setName('access_token').setDescription('Token de Produção Mercado Pago').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('criar_produto')
        .setDescription('Cria produto na loja e exibe o ID gerado')
        .addStringOption(o => o.setName('nome').setDescription('Nome do produto').setRequired(true))
        .addNumberOption(o => o.setName('preco').setDescription('Preço em R$ (ex: 15.50)').setRequired(true))
        .addStringOption(o => o.setName('descricao').setDescription('Descrição do produto').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('add_estoque')
        .setDescription('Adiciona itens ao estoque de um produto')
        .addIntegerOption(o => o.setName('id_produto').setDescription('ID do produto').setRequired(true))
        .addStringOption(o => o.setName('itens').setDescription('Itens separados por vírgula').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('enviar_vitrine')
        .setDescription('Envia o painel de compra neste canal')
        .addIntegerOption(o => o.setName('id_produto').setDescription('ID do produto').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('produtos')
    .setDescription('[DONO] Lista todos os produtos com ID para editar ou remover')
].map(c => c.toJSON());

async function registerCommands() {
  const token = process.env.DISCORD_TOKEN?.trim();
  const clientId = process.env.CLIENT_ID?.trim();
  if (!token || !clientId) return;
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('✅ Comandos registrados.');
  } catch (e) {
    console.error('❌ Erro ao registrar comandos:', e);
  }
}

let readyHandled = false;
async function onBotReady() {
  if (readyHandled) return;
  readyHandled = true;
  console.log(`✅ Bot online como ${client.user.tag}`);
  if (process.env.REGISTER_COMMANDS === 'true') {
    await registerCommands();
  }
}

client.once('ready', onBotReady);
client.once('clientReady', onBotReady);

const getMP = (token) => new Payment(new MercadoPagoConfig({ accessToken: token }));

function isValidImageUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

async function buildProductsView(guildId) {
  const products = await db.getProductsByGuild(guildId);

  if (!products.length) {
    return {
      embed: new EmbedBuilder()
        .setTitle('📦 Produtos da Loja')
        .setDescription('Nenhum produto cadastrado ainda.\nUse `/painel_dono criar_produto` para criar o primeiro e ver o **ID**.')
        .setColor('#95a5a6'),
      components: []
    };
  }

  const lines = products.map(p => {
    const stockCount = JSON.parse(p.stock || '[]').length;
    return `• **ID #${p.id}** — **${p.name}** | R$ ${Number(p.price).toFixed(2)} | Estoque: **${stockCount}**\n  _${p.description}_`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📦 Gerenciador de Produtos')
    .setDescription(lines.join('\n\n').slice(0, 4000))
    .setColor('#3498db')
    .setFooter({ text: 'Selecione um produto abaixo para editar ou remover' });

  const options = products.slice(0, 25).map(p => ({
    label: `#${p.id} - ${p.name}`.slice(0, 100),
    description: `R$ ${Number(p.price).toFixed(2)} • Estoque: ${JSON.parse(p.stock || '[]').length}`.slice(0, 100),
    value: String(p.id)
  }));

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('prod_select')
      .setPlaceholder('Escolha um produto pelo ID...')
      .addOptions(options)
  );

  return { embed, components: [selectRow] };
}

client.on('interactionCreate', async (interaction) => {
  try {
    // COMANDOS /MASTER
    if (interaction.isChatInputCommand() && interaction.commandName === 'master') {
      if (interaction.user.id !== process.env.MASTER_ID?.trim()) {
        return interaction.reply({ content: '⛔ Acesso negado. Comando exclusivo do Master.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();

      if (sub === 'painel') {
        const all = await db.getAllLicenses();
        const activeCount = all.filter(l => l.isOperational).length;
        const ownersCount = new Set(all.map(l => l.owner_id)).size;

        const resumo = all.slice(0, 15).map(l =>
          `• **${l.store_name}** (\`${l.guild_id}\`) — Dono: <@${l.owner_id}> | ${l.isOperational ? '🟢 Ativo' : '🔴 Inativo'} (${l.daysLeft}d)`
        ).join('\n') || 'Nenhuma loja cadastrada.';

        const embed = new EmbedBuilder()
          .setTitle('👑 Painel Geral — Master')
          .addFields(
            { name: '🏪 Total de Lojas', value: `${all.length}`, inline: true },
            { name: '🟢 Lojas Ativas', value: `${activeCount}`, inline: true },
            { name: '👤 Clientes (Donos)', value: `${ownersCount}`, inline: true },
            { name: '📋 Lojas Recentes', value: resumo.slice(0, 1024) }
          )
          .setColor('#f1c40f');

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      const guildId = interaction.options.getString('id_servidor').trim();

      if (sub === 'ativar') {
        const ownerId = interaction.options.getString('id_dono').trim();
        const storeName = interaction.options.getString('nome_loja').trim();
        const days = interaction.options.getInteger('dias');
        const lic = await db.upsertLicense(guildId, ownerId, storeName, days);
        await notifyLicenseActivated(lic);

        return interaction.reply({
          content:
            `✅ Loja **${lic.store_name}** (\`${lic.guild_id}\`) ativada para <@${lic.owner_id}> por **${lic.daysLeft} dia(s)**.\n` +
            `📩 Avisos enviados na DM do dono e no canal principal do servidor.`,
          ephemeral: true
        });
      }

      if (sub === 'bloquear') {
        await db.setLicenseStatus(guildId, false);
        return interaction.reply({ content: `🔒 Servidor \`${guildId}\` bloqueado.`, ephemeral: true });
      }

      if (sub === 'desbloquear') {
        const lic = await db.setLicenseStatus(guildId, true);
        if (lic && lic.isOperational) await notifyLicenseActivated(lic);
        return interaction.reply({ content: `🔓 Servidor \`${guildId}\` desbloqueado.`, ephemeral: true });
      }

      if (sub === 'status') {
        const lic = await db.getLicense(guildId);
        if (!lic) return interaction.reply({ content: '❌ Servidor não cadastrado.', ephemeral: true });
        return interaction.reply({
          content:
            `📊 **Loja:** ${lic.store_name}\n` +
            `🖥️ **Servidor:** \`${lic.guild_id}\`\n` +
            `👤 **Dono:** <@${lic.owner_id}>\n` +
            `⚡ **Status:** ${lic.isOperational ? '🟢 Ativo' : '🔴 Bloqueado/Vencido'}\n` +
            `⏳ **Dias restantes:** ${lic.daysLeft} dia(s)\n` +
            `💳 **PIX:** ${lic.mp_token ? 'Configurado' : 'Não configurado'}\n` +
            `🖼️ **Foto da Loja:** ${lic.store_photo ? 'Definida' : 'Padrão'}`,
          ephemeral: true
        });
      }
    }

    if (!interaction.guildId) return;
    const license = await db.getLicense(interaction.guildId);

    if (!license || !license.isOperational) {
      if (interaction.isRepliable()) {
        return interaction.reply({ content: LOCKED_MSG, ephemeral: true });
      }
      return;
    }

    // COMANDOS DO DONO
    if (interaction.isChatInputCommand() && interaction.commandName === 'painel_dono') {
      if (interaction.user.id !== license.owner_id) {
        return interaction.reply({ content: '⛔ Apenas o dono registrado desta loja pode usar este painel.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();

      if (sub === 'painel') {
        const ownerStores = await db.getLicensesByOwner(interaction.user.id);
        const products = await db.getProductsByGuild(interaction.guildId);
        const totalStock = products.reduce((acc, p) => acc + JSON.parse(p.stock || '[]').length, 0);

        const embed = new EmbedBuilder()
          .setTitle(`🏪 Painel do Dono — ${license.store_name}`)
          .addFields(
            { name: '⚡ Estado do Robô', value: '🟢 Ligado / Ativo', inline: true },
            { name: '⏳ Aluguel Restante', value: `${license.daysLeft} dia(s)`, inline: true },
            { name: '💳 PIX (Mercado Pago)', value: license.mp_token ? '✅ Configurado' : '❌ Pendente', inline: true },
            { name: '📦 Produtos', value: `${products.length}`, inline: true },
            { name: '📊 Estoque Total', value: `${totalStock} item(ns)`, inline: true },
            { name: '🏬 Suas Lojas', value: `${ownerStores.length} loja(s)`, inline: true },
            { name: '🖼️ Foto do Servidor', value: license.store_photo ? `[Ver imagem](${license.store_photo})` : 'Nenhuma definida', inline: false },
            { name: '💬 Discord Oficial', value: OFFICIAL_DISCORD, inline: false }
          )
          .setColor('#2ecc71');

        if (license.store_photo && isValidImageUrl(license.store_photo)) {
          embed.setThumbnail(license.store_photo);
        }

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (sub === 'aluguel') {
        return interaction.reply({
          content:
            `🏪 **Loja:** ${license.store_name}\n` +
            `⏳ **Restam:** **${license.daysLeft} dia(s)**.\n` +
            `💬 **Discord Oficial:** ${OFFICIAL_DISCORD}`,
          ephemeral: true
        });
      }

      if (sub === 'foto_loja') {
        const inputUrl = interaction.options.getString('url_imagem').trim();
        if (inputUrl.toLowerCase() === 'remover') {
          await db.setStorePhoto(interaction.guildId, null);
          return interaction.reply({
            content: '🗑️ Foto exclusiva desta loja removida. Ela não afeta outros servidores.',
            ephemeral: true
          });
        }
        if (!isValidImageUrl(inputUrl)) {
          return interaction.reply({
            content: '❌ Informe um link válido começando com `https://` ou `http://` (ou digite `remover`).',
            ephemeral: true
          });
        }
        await db.setStorePhoto(interaction.guildId, inputUrl);
        return interaction.reply({
          content: `✅ Foto exclusiva da loja **${license.store_name}** salva! Ela aparecerá **apenas** nas vitrines e painéis deste servidor.`,
          ephemeral: true
        });
      }

      if (sub === 'config_pix') {
        await db.setMpToken(interaction.guildId, interaction.options.getString('access_token').trim());
        return interaction.reply({ content: '✅ Token do Mercado Pago salvo com segurança!', ephemeral: true });
      }

      if (sub === 'criar_produto') {
        const nome = interaction.options.getString('nome').trim();
        const preco = interaction.options.getNumber('preco');
        const desc = interaction.options.getString('descricao').trim();
        const info = await db.addProduct(interaction.guildId, nome, desc, preco);
        return interaction.reply({
          content:
            `✅ Produto **${nome}** criado com sucesso!\n` +
            `🆔 **ID do Produto:** **#${info.lastInsertRowid}**\n` +
            `💵 **Preço:** R$ ${preco.toFixed(2)}`,
          ephemeral: true
        });
      }

      if (sub === 'add_estoque') {
        const prodId = interaction.options.getInteger('id_produto');
        const items = interaction.options.getString('itens').split(',').map(i => i.trim()).filter(Boolean);
        if (!items.length) return interaction.reply({ content: '❌ Informe ao menos um item.', ephemeral: true });
        const total = await db.addStock(prodId, interaction.guildId, items);
        if (total === false) return interaction.reply({ content: `❌ Produto **#${prodId}** não encontrado.`, ephemeral: true });
        return interaction.reply({ content: `📦 Estoque do produto **#${prodId}** atualizado! Total: **${total} unidade(s)**.`, ephemeral: true });
      }

      if (sub === 'enviar_vitrine') {
        const prodId = interaction.options.getInteger('id_produto');
        const prod = await db.getProduct(prodId, interaction.guildId);
        if (!prod) return interaction.reply({ content: `❌ Produto **#${prodId}** não encontrado.`, ephemeral: true });

        const stockCount = JSON.parse(prod.stock || '[]').length;
        const embed = new EmbedBuilder()
          .setTitle(`🛒 ${license.store_name} — ${prod.name}`)
          .setDescription(prod.description)
          .addFields(
            { name: '🆔 ID', value: `#${prod.id}`, inline: true },
            { name: '💵 Valor', value: `R$ ${Number(prod.price).toFixed(2)}`, inline: true },
            { name: '📦 Estoque', value: `${stockCount} disponível(is)`, inline: true }
          )
          .setColor('#2ecc71')
          .setFooter({ text: 'Entrega automática após confirmação do PIX' });

        if (license.store_photo && isValidImageUrl(license.store_photo)) {
          embed.setImage(license.store_photo);
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`comprar_${prod.id}`).setLabel('Comprar via PIX').setStyle(ButtonStyle.Success)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: `✅ Vitrine do produto **#${prod.id}** enviada neste canal!`, ephemeral: true });
      }
    }

    // COMANDO /PRODUTOS
    if (interaction.isChatInputCommand() && interaction.commandName === 'produtos') {
      if (interaction.user.id !== license.owner_id) {
        return interaction.reply({ content: '⛔ Apenas o dono desta loja pode gerenciar os produtos.', ephemeral: true });
      }
      const view = await buildProductsView(interaction.guildId);
      return interaction.reply({ embeds: [view.embed], components: view.components, ephemeral: true });
    }

    // SELECT DE PRODUTO (/produtos)
    if (interaction.isStringSelectMenu() && interaction.customId === 'prod_select') {
      if (interaction.user.id !== license.owner_id) {
        return interaction.reply({ content: '⛔ Apenas o dono da loja pode alterar produtos.', ephemeral: true });
      }
      const prodId = parseInt(interaction.values[0], 10);
      const prod = await db.getProduct(prodId, interaction.guildId);
      if (!prod) return interaction.reply({ content: '❌ Produto não encontrado.', ephemeral: true });

      const stockCount = JSON.parse(prod.stock || '[]').length;
      const embed = new EmbedBuilder()
        .setTitle(`🛠️ Produto #${prod.id} — ${prod.name}`)
        .setDescription(prod.description)
        .addFields(
          { name: '🆔 ID', value: `#${prod.id}`, inline: true },
          { name: '💵 Preço', value: `R$ ${Number(prod.price).toFixed(2)}`, inline: true },
          { name: '📦 Estoque', value: `${stockCount}`, inline: true }
        )
        .setColor('#e67e22');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`prod_edit_${prod.id}`).setLabel('Editar').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`prod_del_${prod.id}`).setLabel('Remover').setStyle(ButtonStyle.Danger)
      );

      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    // BOTÃO EDITAR PRODUTO -> ABRE MODAL
    if (interaction.isButton() && interaction.customId.startsWith('prod_edit_')) {
      if (interaction.user.id !== license.owner_id) {
        return interaction.reply({ content: '⛔ Apenas o dono da loja pode editar produtos.', ephemeral: true });
      }
      const prodId = parseInt(interaction.customId.replace('prod_edit_', ''), 10);
      const prod = await db.getProduct(prodId, interaction.guildId);
      if (!prod) return interaction.reply({ content: '❌ Produto não encontrado.', ephemeral: true });

      const modal = new ModalBuilder()
        .setCustomId(`prod_modal_${prod.id}`)
        .setTitle(`Editar Produto #${prod.id}`);

      const nameInput = new TextInputBuilder()
        .setCustomId('nome')
        .setLabel('Nome do produto')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(prod.name).slice(0, 100));

      const priceInput = new TextInputBuilder()
        .setCustomId('preco')
        .setLabel('Preço em R$ (ex: 19.90)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(Number(prod.price)));

      const descInput = new TextInputBuilder()
        .setCustomId('descricao')
        .setLabel('Descrição')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setValue(String(prod.description).slice(0, 1000));

      modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(priceInput),
        new ActionRowBuilder().addComponents(descInput)
      );

      return interaction.showModal(modal);
    }

    // SUBMISSÃO DO MODAL DE EDIÇÃO
    if (interaction.isModalSubmit() && interaction.customId.startsWith('prod_modal_')) {
      if (interaction.user.id !== license.owner_id) {
        return interaction.reply({ content: '⛔ Apenas o dono da loja pode editar produtos.', ephemeral: true });
      }
      const prodId = parseInt(interaction.customId.replace('prod_modal_', ''), 10);
      const nome = interaction.fields.getTextInputValue('nome').trim();
      const precoRaw = interaction.fields.getTextInputValue('preco').replace(',', '.').trim();
      const preco = Number(precoRaw);
      const descricao = interaction.fields.getTextInputValue('descricao').trim();

      if (Number.isNaN(preco) || preco <= 0) {
        return interaction.reply({ content: '❌ Preço inválido.', ephemeral: true });
      }

      const updated = await db.updateProduct(prodId, interaction.guildId, { name: nome, price: preco, description: descricao });
      if (!updated) return interaction.reply({ content: '❌ Produto não encontrado.', ephemeral: true });

      return interaction.reply({
        content: `✅ Produto **#${updated.id}** (**${updated.name}**) atualizado para **R$ ${Number(updated.price).toFixed(2)}**!`,
        ephemeral: true
      });
    }

    // BOTÃO REMOVER PRODUTO
    if (interaction.isButton() && interaction.customId.startsWith('prod_del_')) {
      if (interaction.user.id !== license.owner_id) {
        return interaction.reply({ content: '⛔ Apenas o dono da loja pode remover produtos.', ephemeral: true });
      }
      const prodId = parseInt(interaction.customId.replace('prod_del_', ''), 10);
      const ok = await db.deleteProduct(prodId, interaction.guildId);
      if (!ok) return interaction.reply({ content: '❌ Produto não encontrado ou já removido.', ephemeral: true });

      return interaction.reply({
        content: `🗑️ Produto **#${prodId}** removido com sucesso!`,
        ephemeral: true
      });
    }

    // COMPRAR VIA PIX
    if (interaction.isButton() && interaction.customId.startsWith('comprar_')) {
      const prodId = parseInt(interaction.customId.split('_')[1], 10);
      const prod = await db.getProduct(prodId, interaction.guildId);
      if (!prod) return interaction.reply({ content: '❌ Produto indisponível.', ephemeral: true });
      if (!JSON.parse(prod.stock || '[]').length) return interaction.reply({ content: '❌ Sem estoque.', ephemeral: true });
      if (!license.mp_token) return interaction.reply({ content: '⚠️ PIX não configurado pelo dono.', ephemeral: true });

      await interaction.deferReply({ ephemeral: true });
      try {
        const res = await getMP(license.mp_token).create({
          body: {
            transaction_amount: Number(prod.price),
            description: `${license.store_name} - ${prod.name}`,
            payment_method_id: 'pix',
            payer: { email: `cliente_${interaction.user.id}@vendasbot.com` }
          }
        });
        const pix = res.point_of_interaction.transaction_data.qr_code;
        const embed = new EmbedBuilder()
          .setTitle(`💠 PIX — ${prod.name}`)
          .setDescription(`Valor: **R$ ${Number(prod.price).toFixed(2)}**\n\n\`\`\`${pix}\`\`\`\nApós pagar, clique em **Verificar Pagamento**.`)
          .setColor('#00b0f4');

        if (license.store_photo && isValidImageUrl(license.store_photo)) {
          embed.setThumbnail(license.store_photo);
        }

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`verificar_${res.id}_${prod.id}`).setLabel('Verificar Pagamento').setStyle(ButtonStyle.Primary)
        );
        await interaction.editReply({ embeds: [embed], components: [row] });
      } catch (err) {
        console.error('❌ Erro PIX:', err);
        await interaction.editReply({ content: '❌ Erro ao gerar PIX. Confira o Token do Mercado Pago.' });
      }
    }

    // VERIFICAR PAGAMENTO PIX
    if (interaction.isButton() && interaction.customId.startsWith('verificar_')) {
      const [, paymentId, prodIdStr] = interaction.customId.split('_');
      const prodId = parseInt(prodIdStr, 10);

      await interaction.deferReply({ ephemeral: true });
      try {
        const statusRes = await getMP(license.mp_token).get({ id: paymentId });
        if (statusRes.status === 'approved') {
          const item = await db.popStockItem(prodId, interaction.guildId);
          if (!item) {
            return interaction.editReply({ content: `⚠️ Pago, mas o estoque acabou. Comprovante: ${paymentId}` });
          }
          try {
            await interaction.user.send(`🎉 **Compra Aprovada — ${license.store_name}!**\n\n📦 **Produto:**\n\`\`\`${item}\`\`\``);
            await interaction.editReply({ content: '✅ Pagamento aprovado! Produto enviado na sua DM.' });
          } catch {
            await interaction.editReply({ content: `✅ Pagamento aprovado! Sua DM estava fechada:\n\`\`\`${item}\`\`\`` });
          }
        } else {
          await interaction.editReply({ content: `⏳ Status atual: **${statusRes.status}**. Tente novamente em instantes.` });
        }
      } catch (err) {
        console.error('❌ Erro ao verificar pagamento:', err);
        await interaction.editReply({ content: '❌ Erro ao consultar pagamento.' });
      }
    }
  } catch (err) {
    console.error('❌ Erro na interação:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Erro ao processar solicitação.', ephemeral: true }).catch(() => {});
    }
  }
});

async function startBot() {
  const token = process.env.DISCORD_TOKEN?.trim();
  console.log('🔄 Tentando logar no Discord... Token existe?', Boolean(token), 'Tamanho:', token?.length || 0);
  if (!token) throw new Error('DISCORD_TOKEN ausente.');
  await client.login(token);
}

module.exports = { startBot, client, notifyLicenseActivated };
