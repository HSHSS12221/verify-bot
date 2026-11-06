require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { createDiscordBot } = require('./discord-bot');

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'BOT_WEBHOOK_SECRET'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
const discord = createDiscordBot({ supabase });
if (!discord) throw new Error('Discord bot failed to initialize');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, discord_ready: discord.isReady() }));
app.post('/internal/approved', async (req, res) => {
  if (!validWebhookSecret(req.get('authorization'))) return res.status(401).json({ error: 'Unauthorized' });
  const discordId = String(req.body.discord_id || '').trim();
  if (!/^\d{17,20}$/.test(discordId)) return res.status(400).json({ error: 'A valid discord_id is required' });
  try {
    await discord.sendWhitelistApprovedDM(discordId);
    return res.json({ sent: true });
  } catch (error) {
    console.error('[Discord] Could not DM approved player:', error.message);
    return res.status(502).json({ error: 'Could not deliver the Discord DM. The user may have DMs disabled.' });
  }
});

function validWebhookSecret(header = '') {
  if (!header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(process.env.BOT_WEBHOOK_SECRET);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => console.log(`HSH Discord bot service listening on ${port}`));
