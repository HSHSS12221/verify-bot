const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ChannelType,
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

  const client = new Client({ intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ] });
  const verifyMaxAttempts = positiveInt(process.env.DISCORD_VERIFY_MAX_ATTEMPTS, 8);
  const verifyWindowHours = positiveInt(process.env.DISCORD_VERIFY_WINDOW_HOURS, 24);
  const spamMaxMessages = positiveInt(process.env.DISCORD_SPAM_MAX_MESSAGES, 6);
  const spamWindowMs = positiveInt(process.env.DISCORD_SPAM_WINDOW_SECONDS, 5) * 1000;
  const spamTimeoutSteps = parseTimeoutSteps(process.env.DISCORD_SPAM_TIMEOUT_STEPS_SECONDS);
  const spamStrikeResetDays = positiveInt(process.env.DISCORD_SPAM_STRIKE_RESET_DAYS, 30);
  let runtimeSettings = {};
  const messageWindows = new Map();
  const spamActionAt = new Map();
  const autoBanActionAt = new Map();
  const managedVoiceRooms = new Set();
  client.sendWhitelistApprovedDM = async discordId => {
    if (!/^\d{17,20}$/.test(String(discordId || ''))) throw new Error('Discord ID is invalid');
    const user = await client.users.fetch(String(discordId));
    await user.send('Owner has approve your whitelist!!');
  };
  const adminRoleIds = new Set((process.env.DISCORD_ADMIN_ROLE_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
  const controlCommand = new SlashCommandBuilder().setName('control').setDescription('Open the HSH Verify and Guide control panel');
  const voiceControlCommand = new SlashCommandBuilder().setName('voice-control').setDescription('Configure the HSH Join-to-Create voice room');
  const communityControlCommand = new SlashCommandBuilder().setName('community-control').setDescription('Configure the spam-trap auto-ban channel');
  const welcomeControlCommand = new SlashCommandBuilder().setName('welcome-control').setDescription('Configure the welcome channel, message, and image');
  const goodbyeControlCommand = new SlashCommandBuilder().setName('goodbye-control').setDescription('Configure the goodbye channel, message, and image');

  client.once('ready', async () => {
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [
        controlCommand.toJSON(), voiceControlCommand.toJSON(), communityControlCommand.toJSON(),
        welcomeControlCommand.toJSON(), goodbyeControlCommand.toJSON()
      ] });
      console.log(`[Discord] Logged in as ${client.user.tag}; /control, /voice-control, /community-control, /welcome-control, and /goodbye-control registered in guild ${guildId}.`);
    } catch (error) {
      console.error('[Discord] Could not register /control:', error.message);
    }
    await refreshRuntimeSettings();
  });

  client.on('guildMemberAdd', async member => {
    if (!member.user.bot) await sendConfiguredMemberMessage(member, 'welcome');
  });
  client.on('guildMemberRemove', async member => {
    if (!member.user?.bot) await sendConfiguredMemberMessage(member, 'goodbye');
  });

  // Create a private-to-owner voice room when a member joins the configured lobby.
  // Empty rooms created by the bot are removed automatically.
  client.on('voiceStateUpdate', async (oldState, newState) => {
    const createChannelId = String(runtimeSettings.voice_lobby_channel_id || '').trim();
    if (!createChannelId || newState.channelId !== createChannelId || oldState.channelId === createChannelId) return;
    try {
      const guild = newState.guild;
      const categoryId = runtimeSettings.voice_category_id || newState.channel?.parentId || null;
      const requestedLimit = Number(runtimeSettings.voice_user_limit ?? 8);
      const userLimit = Number.isInteger(requestedLimit) && requestedLimit >= 0 && requestedLimit <= 99 ? requestedLimit : 8;
      const baseName = (newState.member?.displayName || newState.member?.user?.username || 'Player').replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
      const room = await guild.channels.create({
        name: `🎙️ ${baseName}`,
        type: ChannelType.GuildVoice,
        ...(categoryId ? { parent: categoryId } : {}),
        userLimit,
        reason: `Join-to-create room for ${newState.id}`
      });
      managedVoiceRooms.add(room.id);
      try {
        await newState.setChannel(room, 'Join-to-create room');
      } catch (error) {
        managedVoiceRooms.delete(room.id);
        await room.delete('Could not move member into Join-to-create room').catch(() => {});
        throw error;
      }
      console.log(`[Voice] Created ${room.id} for member ${newState.id}`);
    } catch (error) {
      console.error(`[Voice] Could not create/move member ${newState.id}:`, error.message);
    }
  });

  client.on('voiceStateUpdate', async (oldState, newState) => {
    const channel = oldState.channel;
    if (!channel || channel.id === runtimeSettings.voice_lobby_channel_id) return;
    // Delete only rooms created by this running bot process.
    if (!managedVoiceRooms.has(channel.id)) return;
    try {
      const fresh = await channel.fetch();
      if (fresh.members.size === 0) {
        await fresh.delete('Join-to-create room is empty');
        managedVoiceRooms.delete(channel.id);
        console.log(`[Voice] Deleted empty room ${channel.id}`);
      }
    } catch (error) {
      if (error.code !== 10003) console.error(`[Voice] Could not remove empty room ${channel.id}:`, error.message);
    }
  });

  // Dedicated trap-channel rule: ban any account that posts there. This is intentionally
  // channel-scoped and runs before the bot-account filter so spam bots are included.
  client.on('messageCreate', async message => {
    const autoBanChannelId = String(runtimeSettings.auto_ban_channel_id || '').trim();
    if (!autoBanChannelId || !message.guild || message.channelId !== autoBanChannelId || message.author.id === client.user?.id) return;
    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    if (now - (autoBanActionAt.get(key) || 0) < 15000) return;
    autoBanActionAt.set(key, now);
    try { await message.delete(); } catch (error) { console.warn('[Anti-spam] Could not remove trap-channel message:', error.message); }
    try {
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (member && !member.bannable) {
        console.warn(`[Anti-spam] Auto-ban blocked for ${message.author.id}: bot lacks Ban Members permission or target role is too high.`);
        return;
      }
      await message.guild.members.ban(message.author.id, {
        reason: `Automatic ban: posted in designated spam trap channel ${autoBanChannelId}`,
        deleteMessageSeconds: 0
      });
      console.log(`[Anti-spam] Banned ${message.author.id} after posting in trap channel ${autoBanChannelId}.`);
    } catch (error) {
      console.error(`[Anti-spam] Could not auto-ban ${message.author.id}:`, error.message);
    }
  });

  // Burst limiter: count guild messages without reading message content. No Message Content
  // privileged intent is needed. The bot deletes the triggering message and times out spam.
  client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    const now = Date.now();
    const key = `${message.guild.id}:${message.author.id}`;
    const timestamps = (messageWindows.get(key) || []).filter(time => now - time < spamWindowMs);
    timestamps.push(now);
    messageWindows.set(key, timestamps);
    if (timestamps.length <= spamMaxMessages || now - (spamActionAt.get(key) || 0) < spamWindowMs) return;
    spamActionAt.set(key, now);
    try { await message.delete(); } catch (error) { console.warn('[Anti-spam] Could not delete message:', error.message); }
    try {
      const { data: strike, error: strikeError } = await supabase.rpc('register_discord_spam_strike', {
        p_guild_id: message.guild.id,
        p_discord_id: message.author.id,
        p_reset_days: spamStrikeResetDays
      });
      if (strikeError) throw strikeError;
      const strikeCount = Number(strike) || 1;
      const timeoutSeconds = spamTimeoutSteps[Math.min(strikeCount - 1, spamTimeoutSteps.length - 1)];
      const member = message.member || await message.guild.members.fetch(message.author.id);
      if (member.moderatable) {
        await member.timeout(timeoutSeconds * 1000, `Automatic timeout: message burst spam (strike ${strikeCount})`);
      } else {
        console.warn(`[Anti-spam] Member ${message.author.id} cannot be timed out; check bot role hierarchy and Moderate Members permission.`);
      }
      console.log(`[Anti-spam] Rate limited ${message.author.id}; strike ${strikeCount}, timeout ${timeoutSeconds}s`);
    } catch (error) { console.warn('[Anti-spam] Could not timeout member:', error.message); }
  });

  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'control') {
        if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'คำสั่งนี้ใช้ได้เฉพาะเจ้าของเซิร์ฟเวอร์หรือแอดมินเท่านั้น', ephemeral: true });
        await refreshRuntimeSettings();
        return interaction.reply({ content: 'HSH SovereignSoul • Verify Control', components: controlRows(), ephemeral: true });
      }
      if (interaction.isChatInputCommand() && ['voice-control', 'community-control', 'welcome-control', 'goodbye-control'].includes(interaction.commandName)) {
        if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'คำสั่งนี้ใช้ได้เฉพาะเจ้าของเซิร์ฟเวอร์หรือแอดมินเท่านั้น', ephemeral: true });
        await refreshRuntimeSettings();
        if (interaction.commandName === 'voice-control') return interaction.showModal(voiceSettingsModal(runtimeSettings));
        if (interaction.commandName === 'community-control') return interaction.showModal(autoBanSettingsModal(runtimeSettings));
        return interaction.showModal(memberMessageModal(interaction.commandName === 'welcome-control' ? 'welcome' : 'goodbye', runtimeSettings));
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
        if (interaction.customId === `${PREFIX}control:community`) {
          if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'เฉพาะ owner/admin เท่านั้น', ephemeral: true });
          return interaction.showModal(autoBanSettingsModal(runtimeSettings));
        }
        if (interaction.customId === `${PREFIX}control:voice`) {
          if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'เฉพาะ owner/admin เท่านั้น', ephemeral: true });
          return interaction.showModal(voiceSettingsModal(runtimeSettings));
        }
        const guideMatch = interaction.customId.match(/^hsh:control:guide:(th|en):([1-3])$/);
        if (guideMatch) {
          if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'เฉพาะ owner/admin เท่านั้น', ephemeral: true });
          return interaction.showModal(guideModal(guideMatch[1], Number(guideMatch[2])));
        }
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId === `${PREFIX}auto-ban-settings`) {
          if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'เฉพาะ owner/admin เท่านั้น', ephemeral: true });
          return saveAutoBanSettings(interaction);
        }
        if (interaction.customId === `${PREFIX}welcome-settings` || interaction.customId === `${PREFIX}goodbye-settings`) {
          if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'เฉพาะ owner/admin เท่านั้น', ephemeral: true });
          return saveMemberMessageSettings(interaction, interaction.customId === `${PREFIX}welcome-settings` ? 'welcome' : 'goodbye');
        }
        if (interaction.customId === `${PREFIX}voice-settings`) {
          if (!isAdmin(interaction, adminRoleIds)) return interaction.reply({ content: 'เฉพาะ owner/admin เท่านั้น', ephemeral: true });
          return saveVoiceSettings(interaction);
        }
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
      new ButtonBuilder().setCustomId(`${PREFIX}control:publish`).setLabel('ตั้งค่าห้องและโพสต์ปุ่ม Verify').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${PREFIX}control:voice`).setLabel('ตั้งค่า Join-to-Create').setStyle(ButtonStyle.Primary)
    )];
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}control:community`).setLabel('ตั้งค่า Auto-ban').setStyle(ButtonStyle.Success)
    ));
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
    const input = new TextInputBuilder().setCustomId(id).setLabel(String(label).slice(0, 45)).setStyle(style).setRequired(required).setMaxLength(maxLength);
    if (placeholder) input.setPlaceholder(placeholder);
    if (value) input.setValue(String(value).slice(0, maxLength));
    return new ActionRowBuilder().addComponents(input);
  }

  function publishModal() {
    return new ModalBuilder().setCustomId(`${PREFIX}publish`).setTitle('ตั้งค่าห้อง Verify')
      .addComponents(modalRow('channel_id', 'Channel ID ที่จะโพสต์ปุ่ม', TextInputStyle.Short, true, 'คลิกขวาห้อง > Copy Channel ID', 25));
  }

  function memberMessageModal(type, settings) {
    const title = type === 'welcome' ? 'ตั้งค่า Welcome' : 'ตั้งค่า Goodbye';
    return new ModalBuilder().setCustomId(`${PREFIX}${type}-settings`).setTitle(title)
      .addComponents(
        modalRow('channel_id', 'Channel ID (เว้นว่างเพื่อปิด)', TextInputStyle.Short, false, 'ID ห้องข้อความ', 25, settings[`${type}_channel_id`] || ''),
        modalRow('message', 'ข้อความ', TextInputStyle.Paragraph, false, 'รองรับ {user}, {server}, {memberCount}', 1000, settings[`${type}_message`] || ''),
        modalRow('image_url', 'ลิงก์รูป HTTPS', TextInputStyle.Short, false, 'ลิงก์รูปภาพ (ไม่บังคับ)', 2000, settings[`${type}_image_url`] || '')
      );
  }

  function autoBanSettingsModal(settings) {
    return new ModalBuilder().setCustomId(`${PREFIX}auto-ban-settings`).setTitle('ตั้งค่า Auto-ban')
      .addComponents(modalRow('auto_ban_channel_id', 'Channel ID (ว่าง = ปิด Auto-ban)', TextInputStyle.Short, false, 'ID ห้องกับดักสแปม', 25, settings.auto_ban_channel_id || ''));
  }

  function voiceSettingsModal(settings) {
    return new ModalBuilder().setCustomId(`${PREFIX}voice-settings`).setTitle('ตั้งค่า Join-to-Create')
      .addComponents(
        modalRow('voice_lobby_channel_id', 'ห้องรอ Join-to-Create (ว่าง = ปิด)', TextInputStyle.Short, false, 'Voice Channel ID', 25, settings.voice_lobby_channel_id || ''),
        modalRow('voice_category_id', 'หมวดหมู่ห้องใหม่ (ไม่ใส่ = ใช้หมวด lobby)', TextInputStyle.Short, false, 'Category ID', 25, settings.voice_category_id || ''),
        modalRow('voice_user_limit', 'จำนวนคนต่อห้อง (0–99, 0 = ไม่จำกัด)', TextInputStyle.Short, false, '8', 2, String(settings.voice_user_limit ?? 8))
      );
  }

  async function saveVoiceSettings(interaction) {
    const values = {
      voice_lobby_channel_id: interaction.fields.getTextInputValue('voice_lobby_channel_id').trim(),
      voice_category_id: interaction.fields.getTextInputValue('voice_category_id').trim(),
      voice_user_limit: Number(interaction.fields.getTextInputValue('voice_user_limit').trim() || 8),
      updated_at: new Date().toISOString()
    };
    for (const key of ['voice_lobby_channel_id', 'voice_category_id']) {
      if (values[key] && !/^\d{17,20}$/.test(values[key])) return interaction.reply({ content: `${key} ต้องเป็น Channel ID ตัวเลข 17–20 หลัก หรือเว้นว่าง`, ephemeral: true });
    }
    if (!Number.isInteger(values.voice_user_limit) || values.voice_user_limit < 0 || values.voice_user_limit > 99) {
      return interaction.reply({ content: 'จำนวนคนต้องเป็นเลข 0–99 (ใส่ 0 เพื่อไม่จำกัด)', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    if (values.voice_lobby_channel_id) {
      const lobby = await interaction.guild.channels.fetch(values.voice_lobby_channel_id).catch(() => null);
      if (!lobby || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(lobby.type)) {
        return interaction.editReply({ content: 'ไม่พบ Voice Channel ที่ระบุ หรือบอทเข้าไม่ถึงห้องนั้น' });
      }
    }
    if (values.voice_category_id) {
      const category = await interaction.guild.channels.fetch(values.voice_category_id).catch(() => null);
      if (!category || category.type !== ChannelType.GuildCategory) return interaction.editReply({ content: 'ไม่พบหมวดหมู่ Category ที่ระบุ' });
    }
    await saveDiscordSettings(values);
    await refreshRuntimeSettings();
    return interaction.editReply({ content: values.voice_lobby_channel_id
      ? 'บันทึกแล้ว สมาชิกที่เข้าห้อง lobby นี้จะได้ห้องเสียงส่วนตัวชั่วคราว'
      : 'ปิด Join-to-Create แล้ว (เว้น Channel ID ว่าง)' });
  }

  async function saveMemberMessageSettings(interaction, type) {
    const channelId = interaction.fields.getTextInputValue('channel_id').trim();
    const message = interaction.fields.getTextInputValue('message').trim();
    const imageUrl = interaction.fields.getTextInputValue('image_url').trim();
    if (channelId && !/^\d{17,20}$/.test(channelId)) return interaction.reply({ content: 'Channel ID ต้องเป็นตัวเลข 17–20 หลัก หรือเว้นว่างเพื่อปิด', ephemeral: true });
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) return interaction.reply({ content: 'ลิงก์รูปภาพต้องขึ้นต้นด้วย https://', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    if (channelId) {
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased() || !channel.send) return interaction.editReply({ content: 'ไม่พบห้องข้อความ หรือบอทส่งข้อความในห้องนั้นไม่ได้' });
    }
    const values = {
      [`${type}_channel_id`]: channelId || null,
      [`${type}_message`]: message || null,
      [`${type}_image_url`]: imageUrl || null,
      updated_at: new Date().toISOString()
    };
    await saveDiscordSettings(values);
    await refreshRuntimeSettings();
    return interaction.editReply({ content: `บันทึกการตั้งค่า ${type === 'welcome' ? 'Welcome' : 'Goodbye'} แล้ว ข้อความรองรับ {user}, {server}, {memberCount}` });
  }

  async function saveAutoBanSettings(interaction) {
    const channelId = interaction.fields.getTextInputValue('auto_ban_channel_id').trim();
    if (channelId && !/^\d{17,20}$/.test(channelId)) return interaction.reply({ content: 'Channel ID ต้องเป็นตัวเลข 17–20 หลัก หรือเว้นว่างเพื่อปิด', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    if (channelId) {
      const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased() || !channel.send) return interaction.editReply({ content: 'ไม่พบห้องข้อความ หรือบอทเข้าถึงห้องนั้นไม่ได้' });
    }
    await saveDiscordSettings({ auto_ban_channel_id: channelId || null, updated_at: new Date().toISOString() });
    await refreshRuntimeSettings();
    return interaction.editReply({ content: channelId ? 'บันทึกห้อง Auto-ban แล้ว' : 'ปิด Auto-ban แล้ว' });
  }

  async function refreshRuntimeSettings() {
    const { data, error } = await supabase.from('discord_settings')
      .select('auto_ban_channel_id,welcome_channel_id,welcome_message,welcome_image_url,goodbye_channel_id,goodbye_message,goodbye_image_url,voice_lobby_channel_id,voice_category_id,voice_user_limit')
      .eq('id', 1).maybeSingle();
    if (error) {
      console.error('[Discord] Could not load control settings:', error.message);
      return;
    }
    runtimeSettings = data || {};
    if (runtimeSettings.auto_ban_channel_id) {
      console.log(`[Anti-spam] Channel auto-ban enabled for channel ${runtimeSettings.auto_ban_channel_id}; bot needs Ban Members permission and a higher role than targets.`);
    } else {
      console.log('[Anti-spam] Channel auto-ban disabled; configure it in /control.');
    }
  }

  async function saveDiscordSettings(patch) {
    const table = supabase.from('discord_settings');
    const { data: current, error: readError } = await table.select('id').eq('id', 1).maybeSingle();
    if (readError) throw readError;
    const result = current
      ? await table.update(patch).eq('id', 1)
      : await table.insert({ id: 1, ...patch });
    if (result.error) throw result.error;
  }

  async function sendConfiguredMemberMessage(member, type) {
    try {
      const channelId = runtimeSettings[`${type}_channel_id`];
      const template = String(runtimeSettings[`${type}_message`] || '').trim();
      if (!channelId || !template) return;
      const channel = await member.guild.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased() || !channel.send) return;
      const text = template.replaceAll('{user}', `<@${member.id}>`)
        .replaceAll('{server}', member.guild.name)
        .replaceAll('{memberCount}', String(member.guild.memberCount));
      const imageUrl = runtimeSettings[`${type}_image_url`];
      const payload = { content: text, allowedMentions: { users: [member.id], parse: [] } };
      if (imageUrl) payload.embeds = [new EmbedBuilder().setColor(0xc9a64d).setImage(imageUrl)];
      await channel.send(payload);
    } catch (error) {
      console.error(`[Discord] Could not send ${type} message for ${member.id}:`, error.message);
    }
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
    await saveDiscordSettings({ verify_channel_id: channelId, updated_at: new Date().toISOString() });
    const message = await channel.send(verifyPanel());
    await saveDiscordSettings({ verify_message_id: message.id, updated_at: new Date().toISOString() });
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

    const { data: attemptAllowed, error: attemptError } = await supabase.rpc('consume_discord_verify_attempt', {
      p_discord_id: interaction.user.id,
      p_max_attempts: verifyMaxAttempts,
      p_window_hours: verifyWindowHours
    });
    if (attemptError) throw attemptError;
    if (attemptAllowed !== true) {
      return interaction.editReply({ content: english
        ? `You have reached the limit of ${verifyMaxAttempts} verification attempts. Try again after ${verifyWindowHours} hours.`
        : `คุณส่งคำขอยืนยันครบ ${verifyMaxAttempts} ครั้งแล้ว กรุณาลองใหม่หลัง ${verifyWindowHours} ชั่วโมง` });
    }

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

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTimeoutSteps(value) {
  const defaultSteps = '300,900,3600,10800,21600,43200,86400,259200,604800,1209600,2419200';
  const parsed = String(value || defaultSteps)
    .split(',')
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(seconds => Number.isInteger(seconds) && seconds > 0 && seconds <= 2_419_200);
  return parsed.length ? parsed : defaultSteps.split(',').map(Number);
}

module.exports = { createDiscordBot };
