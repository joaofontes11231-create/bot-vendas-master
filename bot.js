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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.on('guildCreate', async (guild) => {
  try {
    let targetChannel = guild.systemChannel;
    if (!targetChannel || !targetChannel.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages)) {
      targetChannel = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages)
      );
    }
    if (targetChannel) {
      await targetChannel.send(
        `Robô de vendas automáticas adicionado no servidor.\n` +
        `-  Estado do Robô: Desligado.\n` +
        `*Para ativar o sistema do robô de vendas automáticas acesse: https://discord.gg/ZQzv7U3Vnw e entre em contato para ativar.`
      );
    }
  } catch (err) {
    console.error('Erro ao enviar boas-vindas:', err);
  }
});

const commands = [
  new SlashCommandBuilder()
    .setName('master')
    .setDescription('[MASTER] Gerenciar aluguéis e bloqueios')
    .addSubcommand(sub =>
      sub.setName('ativar')
        .setDescription('Ativa ou renova uma loja')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
        .addStringOption(o => o.setName('id_dono').setDescription('ID da Conta do Dono').setRequired(true))
        .addStringOption(o => o.setName('nome_loja').setDescription('Nome da Loja').setRequired(true))
        .addIntegerOption(o => o.setName('dias').setDescription('Dias de aluguel').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('bloquear')
        .setDescription('Bloqueia imediatamente o bot em um servidor')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('desbloquear')
        .setDescription('Desbloqueia o bot em um servidor')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Consulta dias restantes e status de um servidor')
        .addStringOption(o => o.setName('id_servidor').setDescription('ID do Servidor').setRequired(true))
    ),

  new SlashCommandBuilder()
    .setName('painel_dono')
    .setDescription('[DONO] Gerencia sua loja, pagamentos e verifica seu aluguel')
    .addSubcommand(sub =>
      sub.setName('aluguel').setDescription('Verifica quantos dias faltam para vencer seu aluguel')
    )
    .addSubcommand(sub =>
      sub.setName('config_pix')
        .setDescription('Configura seu Access Token do Mercado Pago para receber vendas')
        .addStringOption(o => o.setName('access_token').setDescription('Token de Produção Mercado Pago').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('criar_produto')
        .setDescription('Cria um novo produto na loja')
        .addStringOption(o => o.setName('nome').setDescription('Nome do produto').setRequired(true))
        .addNumberOption(o => o.setName('preco').setDescription('Preço em R$ (ex: 15.50)').setRequired(true))
        .addStringOption(o => o.setName('descricao').setDescription('Descrição do produto').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('add_estoque')
        .setDescription('Adiciona itens/chaves/links ao estoque de um produto')
        .addIntegerOption(o => o.setName('id_produto').setDescription('ID do produto').setRequired(true))
        .addStringOption(o => o.setName('itens').setDescription('Separe múltiplos itens por vírgula').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('enviar_vitrine')
        .setDescription('Envia o painel de compra para os clientes neste canal')
        .addIntegerOption(o => o.setName('id_produto').setDescription('ID do produto').setRequired(true))
    )
].map(cmd => cmd.toJSON());

client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Comandos registrados.');
  } catch (e) {
    console.error('Erro ao registrar comandos:', e);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'master') {
    if (interaction.user.id !== process.env.MASTER_ID) {
      return interaction.reply({ content: '⛔ Acesso negado. Comando exclusivo do administrador Master.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.options.getString('id_servidor');

    if (sub === 'ativar') {
      const ownerId = interaction.options.getString('id_dono');
      const storeName = interaction.options.getString('nome_loja');
      const days = interaction.options.getInteger('dias');
      await db.upsertLicense(guildId, ownerId, storeName, days);
      return interaction.reply({ content: `✅ Loja **${storeName}** (\`${guildId}\`) ativada para <@${ownerId}> por **${days} dias**.`, ephemeral: true });
    }

    if (sub === 'bloquear') {
      await db.setLicenseStatus(guildId, false);
      return interaction.reply({ content: `🔒 Servidor \`${guildId}\` **BLOQUEADO** com sucesso.`, ephemeral: true });
    }

    if (sub === 'desbloquear') {
      await db.setLicenseStatus(guildId, true);
      return interaction.reply({ content: `🔓 Servidor \`${guildId}\` **DESBLOQUEADO** com sucesso.`, ephemeral: true });
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
      return interaction.reply({
        content:
          `Robô de vendas automáticas adicionado no servidor.\n` +
          `-  Estado do Robô: Desligado.\n` +
          `*Para ativar o sistema do robô de vendas automáticas acesse: https://discord.gg/ZQzv7U3Vnw e entre em contato para ativar.`,
        ephemeral: true
      });
    }
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'painel_dono') {
    if (interaction.user.id !== license.owner_id) {
      return interaction.reply({ content: '⛔ Apenas o Dono registrado desta loja pode usar este painel.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'aluguel') {
      return interaction.reply({
        content: `🏪 **Loja:** ${license.store_name}\n⏳ **Tempo restante de aluguel:** **${license.daysLeft} dia(s)**.\nPara renovar, entre em contato em: https://discord.gg/ZQzv7U3Vnw`,
        ephemeral: true
      });
    }

    if (sub === 'config_pix') {
      const token = interaction.options.getString('access_token');
      await db.setMpToken(interaction.guildId, token);
      return interaction.reply({ content: '✅ Token do Mercado Pago salvo com segurança!', ephemeral: true });
    }

    if (sub === 'criar_produto') {
      const nome = interaction.options.getString('nome');
      const preco = interaction.options.getNumber('preco');
      const desc = interaction.options.getString('descricao');
      const info = await db.addProduct(interaction.guildId, nome, desc, preco);
      return interaction.reply({ content: `✅ Produto **${nome}** criado com ID **#${info.lastInsertRowid}** (R$ ${preco.toFixed(2)}).`, ephemeral: true });
    }

    if (sub === 'add_estoque') {
      const prodId = interaction.options.getInteger('id_produto');
      const rawItems = interaction.options.getString('itens').split(',').map(i => i.trim()).filter(Boolean);
      const total = await db.addStock(prodId, interaction.guildId, rawItems);
      if (total === false) return interaction.reply({ content: '❌ Produto não encontrado.', ephemeral: true });
      return interaction.reply({ content: `📦 Estoque atualizado! Total disponível agora: **${total} unidade(s)**.`, ephemeral: true });
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
        .setFooter({ text: 'Entrega automática 24h após confirmação do PIX' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`comprar_${prod.id}`)
          .setLabel('Comprar via PIX')
          .setStyle(ButtonStyle.Success)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: '✅ Vitrine enviada no canal!', ephemeral: true });
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith('comprar_')) {
    const prodId = parseInt(interaction.customId.split('_')[1], 10);
    const prod = await db.getProduct(prodId, interaction.guildId);

    if (!prod) return interaction.reply({ content: '❌ Produto indisponível.', ephemeral: true });
    const stockArray = JSON.parse(prod.stock || '[]');
    if (stockArray.length === 0) return interaction.reply({ content: '❌ Produto sem estoque no momento.', ephemeral: true });
    if (!license.mp_token) return interaction.reply({ content: '⚠️ O dono desta loja ainda não configurou o recebimento PIX.', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    try {
      const mpClient = new MercadoPagoConfig({ accessToken: license.mp_token });
      const payment = new Payment(mpClient);

      const res = await payment.create({
        body: {
          transaction_amount: Number(prod.price),
          description: `${license.store_name} - ${prod.name}`,
          payment_method_id: 'pix',
          payer: { email: `cliente_${interaction.user.id}@vendasbot.com` }
        }
      });

      const pixCopiaECola = res.point_of_interaction.transaction_data.qr_code;
      const paymentId = res.id;

      const payEmbed = new EmbedBuilder()
        .setTitle(`💠 Pagamento PIX — ${prod.name}`)
        .setDescription(
          `Valor: **R$ ${Number(prod.price).toFixed(2)}**\n\n` +
          `**Código PIX Copia e Cola:**\n\`\`\`${pixCopiaECola}\`\`\`\n` +
          `Após pagar, clique em **Verificar Pagamento** abaixo.`
        )
        .setColor('#00b0f4');

      const checkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`verificar_${paymentId}_${prod.id}`)
          .setLabel('Verificar Pagamento')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.editReply({ embeds: [payEmbed], components: [checkRow] });
    } catch (error) {
      console.error(error);
      await interaction.editReply({ content: '❌ Erro ao gerar cobrança PIX. Verifique se o Token Mercado Pago do dono é válido.' });
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith('verificar_')) {
    const [, paymentId, prodIdStr] = interaction.customId.split('_');
    const prodId = parseInt(prodIdStr, 10);

    await interaction.deferReply({ ephemeral: true });

    try {
      const mpClient = new MercadoPagoConfig({ accessToken: license.mp_token });
      const payment = new Payment(mpClient);
      const statusRes = await payment.get({ id: paymentId });

      if (statusRes.status === 'approved') {
        const deliveredItem = await db.popStockItem(prodId, interaction.guildId);
        if (!deliveredItem) {
          return interaction.editReply({ content: '⚠️ Pagamento aprovado, mas o estoque acabou segundos antes. Contate o dono da loja com o comprovante ID: ' + paymentId });
        }

        try {
          await interaction.user.send(
            `🎉 **Compra Aprovada na loja ${license.store_name}!**\n\n` +
            `📦 **Seu produto:**\n\`\`\`${deliveredItem}\`\`\``
          );
          await interaction.editReply({ content: '✅ Pagamento confirmado! Seu produto foi enviado na sua **DM**.' });
        } catch {
          await interaction.editReply({ content: `✅ Pagamento confirmado! Sua DM estava fechada, então aqui está seu produto:\n\`\`\`${deliveredItem}\`\`\`` });
        }
      } else {
        await interaction.editReply({ content: `⏳ Pagamento ainda consta como **${statusRes.status}**. Aguarde alguns segundos e clique novamente.` });
      }
    } catch (err) {
      console.error(err);
      await interaction.editReply({ content: '❌ Erro ao consultar pagamento.' });
    }
  }
});

module.exports = {
  startBot: () => client.login(process.env.DISCORD_TOKEN),
  client
};