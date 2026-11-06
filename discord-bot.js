const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const PREFIX = 'hsh:';

function createDiscordBot({ supabase }) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!token && !appId && !guildId) {
    console.log('[Discord] Bot disabled; configure DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID.');
    return null;
  }
  if (!token || !appId || !guildId) {
    console.error('[Discord] Bot not started: all three Discord environment variables are required.');
    return null;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.sendWhitelistApprovedDM = async discordId => {
    if (!/^\d{17,20}$/.test(String(discordId || ''))) throw new Error('Discord ID is invalid');
    const user = await client.users.fetch(String(discordId));
    await user.send('Owner has approve your whitelist!!');
  };
  const adminRoleIds = new Set((process.env.DISCORD_ADMIN_ROLE_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
  const controlCommand = new SlashCommandBuilder().setName('control').setDescription('Open the HSH Verify and Guide control panel');

  client.once('ready', async () => {
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [controlCommand.toJSON()] });
      console.log(`[Discord] Logged in as ${client.user.tag}; /control registered in guild ${guildId}.`);
    } catch (error) {
      console.error('[Discord] Could not register /control:', error.message);
    }
  });

  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'control') {
        if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'คำสั่งนี้ใช้ได้เฉพาะเจ้าของเซิร์ฟเวอร์หรือแอดมินเท่านั้น', ephemeral: true });
        return interaction.reply({ content: 'HSH SovereignSoul • Verify Control', components: controlRows(), ephemeral: true });
      }

      if (interaction.isButton()) {
        if (interaction.customId === `${PREFIX}verify:th` || interaction.customId === `${PREFIX}verify:en`) {
          return interaction.showModal(verifyModal(interaction.customId.endsWith(':en') ? 'en' : 'th', interaction.user.id));
        }
        if (interaction.customId === `${PREFIX}guide`) return interaction.reply({
          content: 'เลือกภาษา / Choose language:', ephemeral: true,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${PREFIX}guide-language:th`).setLabel('ไทย').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`${PREFIX}guide-language:en`).setLabel('English').setStyle(ButtonStyle.Secondary)
          )]
        });
        if (interaction.customId === `${PREFIX}guide-language:th` || interaction.customId === `${PREFIX}guide-language:en`) {
          return showGuides(interaction, interaction.customId.endsWith(':en') ? 'en' : 'th');
        }
        if (interaction.customId === `${PREFIX}control:publish`) return interaction.showModal(publishModal());
        const guideMatch = interaction.customId.match(/^hsh:control:guide:(th|en):([1-3])$/);
        if (guideMatch) {
          if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'เฉพาะ owner/admin เท่านั้น', ephemeral: true });
          return interaction.showModal(guideModal(guideMatch[1], Number(guideMatch[2])));
        }
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId === `${PREFIX}publish`) {
          if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'เฉพาะ owner/admin เท่านั้น', ephemeral: true });
          return publishPanel(interaction);
        }
        const guideMatch = interaction.customId.match(/^hsh:guide-edit:(th|en):([1-3])$/);
        if (guideMatch) {
          if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'เฉพาะ owner/admin เท่านั้น', ephemeral: true });
          return saveGuide(interaction, guideMatch[1], Number(guideMatch[2]));
        }
        if (interaction.customId === `${PREFIX}verify-submit:th` || interaction.customId === `${PREFIX}verify-submit:en`) {
          return submitVerification(interaction, interaction.customId.endsWith(':en') ? 'en' : 'th');
        }
      }
    } catch (error) {
      console.error('[Discord] Interaction failed:', error);
      const reply = { content: `ทำรายการไม่สำเร็จ: ${error.message}`, ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  });

  client.login(token).catch(error => console.error('[Discord] Login failed:', error.message));
  return client;

  function isAdmin(interaction, roles) {
    if (!interaction.inGuild()) return false;
    const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
    const hasAdministrator = interaction.memberPermissions?.has('Administrator') === true;
    const memberRoles = interaction.member?.roles;
    const hasConfiguredRole = Array.isArray(memberRoles)
      ? memberRoles.some(roleId => roles.has(roleId))
      : memberRoles?.cache?.some(role => roles.has(role.id)) === true;
    return isGuildOwner || hasAdministrator || hasConfiguredRole;
  }

  function controlRows() {
    const rows = [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}control:publish`).setLabel('ตั้งค่าห้องและโพสต์ปุ่ม Verify').setStyle(ButtonStyle.Primary)
    )];
    for (const lang of ['th', 'en']) {
      for (let step = 1; step <= 3; step++) {
        const label = `${lang === 'th' ? 'TH' : 'EN'} • Guide ${step}`;
        const button = new ButtonBuilder().setCustomId(`${PREFIX}control:guide:${lang}:${step}`).setLabel(label).setStyle(ButtonStyle.Secondary);
        const rowIndex = 1 + (lang === 'th' ? 0 : 1);
        if (!rows[rowIndex]) rows[rowIndex] = new ActionRowBuilder();
        rows[rowIndex].addComponents(button);
      }
    }
    return rows;
  }

  function verifyPanel() {
    const embed = new EmbedBuilder()
      .setColor(0xc9a64d)
      .setTitle('HSH SovereignSoul • Verify')
      .setDescription('เลือกภาษาและกดปุ่มเพื่อส่งข้อมูลยืนยันตัวตน\nChoose a language and submit your verification details.');
    return {
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}verify:th`).setLabel('ยืนยันตัวตน').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${PREFIX}verify:en`).setLabel('Verify').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${PREFIX}guide`).setLabel('Guide / วิธี Verify').setStyle(ButtonStyle.Secondary)
      )]
    };
  }

  function verifyModal(lang, discordId) {
    const english = lang === 'en';
    return new ModalBuilder()
      .setCustomId(`${PREFIX}verify-submit:${lang}`)
      .setTitle(english ? 'Verify HSH Account' : 'ยืนยันตัวตน HSH')
      .addComponents(
        modalRow('nickname', english ? 'Nickname' : 'ชื่อเล่นที่อยากให้เรียก', TextInputStyle.Short, true, english ? 'Your in-game display name' : 'ชื่อที่อยากให้คนอื่นเรียก', 32),
        modalRow('steam_id', english ? 'SteamID64' : 'SteamID', TextInputStyle.Short, true, '7656119xxxxxxxxxx', 20),
        modalRow('discord_id', english ? 'Discord ID (must be your account)' : 'Discord ID (ต้องเป็นบัญชีของคุณ)', TextInputStyle.Short, true, discordId, 25, discordId)
      );
  }

  function modalRow(id, label, style, required, placeholder, maxLength, value) {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(maxLength);
    if (placeholder) input.setPlaceholder(placeholder);
    if (value) input.setValue(value);
    return new ActionRowBuilder().addComponents(input);
  }

  function publishModal() {
    return new ModalBuilder().setCustomId(`${PREFIX}publish`).setTitle('ตั้งค่าห้อง Verify')
      .addComponents(modalRow('channel_id', 'Channel ID ที่จะโพสต์ปุ่ม', TextInputStyle.Short, true, 'คลิกขวาห้อง > Copy Channel ID', 25));
  }

  function guideModal(lang, step) {
    const langName = lang === 'th' ? 'ไทย' : 'English';
    return new ModalBuilder().setCustomId(`${PREFIX}guide-edit:${lang}:${step}`).setTitle(`Guide ${langName} • ${step}/3`)
      .addComponents(
        modalRow('title', 'หัวข้อ / Title', TextInputStyle.Short, true, 'หัวข้อคู่มือ', 100),
        modalRow('body', 'ข้อความ / Instructions', TextInputStyle.Paragraph, true, 'ใส่ขั้นตอนและรายละเอียด', 1800),
        modalRow('image_url', 'Image URL (optional)', TextInputStyle.Short, false, 'https://example.com/guide.png', 500)
      );
  }

  async function publishPanel(interaction) {
    const channelId = interaction.fields.getTextInputValue('channel_id').trim();
    await interaction.deferReply({ ephemeral: true });
    const channel = await interaction.guild.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !channel.send) return interaction.editReply({ content: 'ไม่พบห้องข้อความนี้ หรือบอทส่งข้อความในห้องไม่ได้' });
    const { error: saveError } = await supabase.from('discord_settings').upsert({ id: 1, verify_channel_id: channelId, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (saveError) throw saveError;
    const message = await channel.send(verifyPanel());
    const { error: updateError } = await supabase.from('discord_settings').update({ verify_message_id: message.id, updated_at: new Date().toISOString() }).eq('id', 1);
    if (updateError) throw updateError;
    return interaction.editReply({ content: `โพสต์ปุ่ม Verify แล้วใน ${channel}` });
  }

  async function saveGuide(interaction, lang, step) {
    const title = interaction.fields.getTextInputValue('title').trim();
    const body = interaction.fields.getTextInputValue('body').trim();
    const imageUrl = interaction.fields.getTextInputValue('image_url').trim();
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) return interaction.reply({ content: 'Image URL ต้องขึ้นต้นด้วย https://', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const { error } = await supabase.from('discord_verification_guides').upsert({
      language: lang, step, title, body, image_url: imageUrl || null, updated_at: new Date().toISOString()
    }, { onConflict: 'language,step' });
    if (error) throw error;
    return interaction.editReply({ content: `บันทึกคู่มือ ${lang.toUpperCase()} ขั้น ${step}/3 แล้ว` });
  }

  async function showGuides(interaction, lang) {
    const { data, error } = await supabase.from('discord_verification_guides').select('step,title,body,image_url').eq('language', lang).order('step');
    if (error) throw error;
    const guides = data || [];
    const embeds = guides.map(item => {
      const embed = new EmbedBuilder().setColor(0xc9a64d).setTitle(`${item.step}/3 • ${item.title}`).setDescription(item.body || '');
      if (item.image_url) embed.setImage(item.image_url);
      return embed;
    });
    if (!embeds.length) embeds.push(new EmbedBuilder().setColor(0xc9a64d).setTitle('Guide').setDescription('คู่มือยังไม่ได้ตั้งค่า ใช้ /control เพื่อเพิ่มเนื้อหา'));
    return interaction.reply({ embeds, ephemeral: true });
  }

  async function submitVerification(interaction, lang) {
    const nickname = interaction.fields.getTextInputValue('nickname').trim();
    const steamId = interaction.fields.getTextInputValue('steam_id').trim();
    const submittedDiscordId = interaction.fields.getTextInputValue('discord_id').trim();
    const english = lang === 'en';
    if (!/^7656119\d{10}$/.test(steamId)) return interaction.reply({ content: english ? 'Enter a valid 17-digit SteamID64.' : 'กรุณาใส่ SteamID64 ตัวเลข 17 หลักให้ถูกต้อง', ephemeral: true });
    if (submittedDiscordId !== interaction.user.id) return interaction.reply({ content: english ? 'Discord ID must match your signed-in Discord account.' : 'Discord ID ต้องตรงกับบัญชี Discord ที่กำลังกดปุ่ม', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });

    const { data: existing, error: existingError } = await supabase.from('whitelists').select('id,status').eq('steam_id', steamId).maybeSingle();
    if (existingError) throw existingError;
    if (existing && ['approved', 'banned'].includes(existing.status)) {
      const message = existing.status === 'approved'
        ? (english ? 'This Steam account is already verified.' : 'SteamID นี้ได้รับอนุมัติแล้ว')
        : (english ? 'This Steam account is banned. Contact an administrator.' : 'SteamID นี้ถูกแบน กรุณาติดต่อแอดมิน');
      return interaction.editReply({ content: message });
    }
    const { data: discordOwner, error: discordError } = await supabase.from('whitelists').select('steam_id').eq('discord_id', submittedDiscordId).limit(1).maybeSingle();
    if (discordError) throw discordError;
    if (discordOwner && discordOwner.steam_id !== steamId) return interaction.editReply({ content: english ? 'This Discord account is already linked to another Steam account.' : 'Discord นี้ผูกกับ SteamID อื่นแล้ว' });

    const row = {
      steam_id: steamId,
      discord_id: submittedDiscordId,
      player_name: nickname,
      status: 'pending',
      profile: { display: 'Profile_Default', displayName: nickname, lastNameUpdate: null },
      updated_at: new Date().toISOString()
    };
    const result = existing
      ? await supabase.from('whitelists').update(row).eq('steam_id', steamId).select('id').single()
      : await supabase.from('whitelists').insert(row).select('id').single();
    if (result.error) throw result.error;
    return interaction.editReply({
      content: english
        ? 'Verification submitted. Your status is Pending; an administrator must approve it before the launcher can access the game.'
        : 'ส่งข้อมูลยืนยันแล้ว สถานะ Pending รอแอดมินอนุมัติ จากนั้น Launcher จึงจะเข้าเกมได้'
    });
  }
}

module.exports = { createDiscordBot };
