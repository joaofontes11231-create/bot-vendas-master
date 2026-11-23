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
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const db = require('./database');

const LOCKED_MSG =
  `Robô de vendas automáticas adicionado no servidor.\n` +
  `-  Estado do Robô: Desligado.\n` +
  `*Para ativar o sistema do robô de vendas automáticas acesse: https://discord.gg/ZQzv7U3Vnw e entre em contato para ativar.`;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.on('error', (err) => console.error('❌ Erro no client:', err));
client.on('shardError', (err) => console.error('❌ Erro de shard/WebSocket:', err));

client.on('guildCreate', async (guild) => {
  try {
    const ch =
      (guild.systemChannel?.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages) && guild.systemChannel) ||
      guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages));
    if (ch) await ch.send(LOCKED_MSG);
  } catch (err) {
    console.error('❌ Erro ao enviar aviso inicial:', err);
  }
});

const commands = [
  new SlashCommandBuilder()
    .setName('master')
    .setDescription('[MASTER] Gerenciar aluguéis e bloqueios')
    .addSubcommand(s => s.setName('ativar').setDescription('Ativa ou renova uma loja')
      .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
      .addStringOption(o => o.setName('id_dono').setDescription('ID da Conta do Dono').setRequired(true))
      .addStringOption(o => o.setName('nome_loja').setDescription('Nome da Loja').setRequired(true))
      .addIntegerOption(o => o.setName('dias').setDescription('Dias de aluguel').setRequired(true)))
    .addSubcommand(s => s.setName('bloquear').setDescription('Bloqueia um servidor')
      .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true)))
    .addSubcommand(s => s.setName('desbloquear').setDescription('Desbloqueia um servidor')
      .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true)))
    .addSubcommand(s => s.setName('status').setDescription('Consulta dias restantes e status')
      .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))),

  new SlashCommandBuilder()
    .setName('painel_dono')
    .setDescription('[DONO] Gerencia loja, PIX, estoque e vitrine')
    .addSubcommand(s => s.setName('aluguel').setDescription('Dias restantes do aluguel'))
    .addSubcommand(s => s.setName('config_pix').setDescription('Configura Access Token do Mercado Pago')
      .addStringOption(o => o.setName('access_token').setDescription('Token de Produção MP').setRequired(true)))
    .addSubcommand(s => s.setName('criar_produto').setDescription('Cria produto na loja')
      .addStringOption(o => o.setName('nome').setDescription('Nome').setRequired(true))
      .addNumberOption(o => o.setName('preco').setDescription('Preço em R$').setRequired(true))
      .addStringOption(o => o.setName('descricao').setDescription('Descrição').setRequired(true)))
    .addSubcommand(s => s.setName('add_estoque').setDescription('Adiciona itens ao estoque')
      .addIntegerOption(o => o.setName('id_produto').setDescription('ID do produto').setRequired(true))
      .addStringOption(o => o.setName('itens').setDescription('Itens separados por vírgula').setRequired(true)))
    .addSubcommand(s => s.setName('enviar_vitrine').setDescription('Envia painel de compra no canal')
      .addIntegerOption(o => o.setName('id_produto').setDescription('ID do produto').setRequired(true)))
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

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'master') {
      if (interaction.user.id !== process.env.MASTER_ID?.trim()) {
        return interaction.reply({ content: '⛔ Acesso negado.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.options.getString('id_servidor').trim();

      if (sub === 'ativar') {
        const ownerId = interaction.options.getString('id_dono').trim();
        const storeName = interaction.options.getString('nome_loja').trim();
        const days = interaction.options.getInteger('dias');
        await db.upsertLicense(guildId, ownerId, storeName, days);
        return interaction.reply({ content: `✅ Loja **${storeName}** (\`${guildId}\`) ativada para <@${ownerId}> por **${days} dias**.`, ephemeral: true });
      }
      if (sub === 'bloquear') {
        await db.setLicenseStatus(guildId, false);
        return interaction.reply({ content: `🔒 Servidor \`${guildId}\` bloqueado.`, ephemeral: true });
      }
      if (sub === 'desbloquear') {
        await db.setLicenseStatus(guildId, true);
        return interaction.reply({ content: `🔓 Servidor \`${guildId}\` desbloqueado.`, ephemeral: true });
      }
      if (sub === 'status') {
        const lic = await db.getLicense(guildId);
        if (!lic) return interaction.reply({ content: '❌ Servidor não cadastrado.', ephemeral: true });
        return interaction.reply({
          content: `📊 **Loja:** ${lic.store_name}\n👤 **Dono:** <@${lic.owner_id}>\n⚡ **Status:** ${lic.active && !lic.isExpired ? 'Ativo' : 'Bloqueado/Vencido'}\n⏳ **Dias restantes:** ${lic.daysLeft} dias`,
          ephemeral: true
        });
      }
    }

    if (!interaction.guildId) return;
    const license = await db.getLicense(interaction.guildId);

    if (!license || !license.active || license.isExpired) {
      if (interaction.isRepliable()) {
        return interaction.reply({ content: LOCKED_MSG, ephemeral: true });
      }
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'painel_dono') {
      if (interaction.user.id !== license.owner_id) {
        return interaction.reply({ content: '⛔ Apenas o dono da loja pode usar este painel.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();

      if (sub === 'aluguel') {
        return interaction.reply({
          content: `🏪 **Loja:** ${license.store_name}\n⏳ **Restam:** **${license.daysLeft} dia(s)**.\nRenovação: https://discord.gg/ZQzv7U3Vnw`,
          ephemeral: true
        });
      }
      if (sub === 'config_pix') {
        await db.setMpToken(interaction.guildId, interaction.options.getString('access_token').trim());
        return interaction.reply({ content: '✅ Token do Mercado Pago salvo!', ephemeral: true });
      }
      if (sub === 'criar_produto') {
        const nome = interaction.options.getString('nome').trim();
        const preco = interaction.options.getNumber('preco');
        const desc = interaction.options.getString('descricao').trim();
        const info = await db.addProduct(interaction.guildId, nome, desc, preco);
        return interaction.reply({ content: `✅ Produto **${nome}** criado (**#${info.lastInsertRowid}** — R$ ${preco.toFixed(2)}).`, ephemeral: true });
      }
      if (sub === 'add_estoque') {
        const prodId = interaction.options.getInteger('id_produto');
        const items = interaction.options.getString('itens').split(',').map(i => i.trim()).filter(Boolean);
        if (!items.length) return interaction.reply({ content: '❌ Informe ao menos um item.', ephemeral: true });
        const total = await db.addStock(prodId, interaction.guildId, items);
        if (total === false) return interaction.reply({ content: '❌ Produto não encontrado.', ephemeral: true });
        return interaction.reply({ content: `📦 Estoque atualizado: **${total} unidade(s)**. `, ephemeral: true });
      }
      if (sub === 'enviar_vitrine') {
        const prodId = interaction.options.getInteger('id_produto');
        const prod = await db.getProduct(prodId, interaction.guildId);
        if (!prod) return interaction.reply({ content: '❌ Produto não encontrado.', ephemeral: true });

        const stockCount = JSON.parse(prod.stock || '[]').length;
        const embed = new EmbedBuilder()
          .setTitle(`🛒 ${license.store_name} — ${prod.name}`)
          .setDescription(prod.description)
          .addFields(
            { name: '💵 Valor', value: `R$ ${Number(prod.price).toFixed(2)}`, inline: true },
            { name: '📦 Estoque', value: `${stockCount} disponíveis`, inline: true }
          )
          .setColor('#2ecc71')
          .setFooter({ text: 'Entrega automática após confirmação do PIX' });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`comprar_${prod.id}`).setLabel('Comprar via PIX').setStyle(ButtonStyle.Success)
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: '✅ Vitrine enviada!', ephemeral: true });
      }
    }

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
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`verificar_${res.id}_${prod.id}`).setLabel('Verificar Pagamento').setStyle(ButtonStyle.Primary)
        );
        await interaction.editReply({ embeds: [embed], components: [row] });
      } catch (err) {
        console.error('❌ Erro PIX:', err);
        await interaction.editReply({ content: '❌ Erro ao gerar PIX. Confira o Token do Mercado Pago.' });
      }
    }

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

module.exports = { startBot, client };
