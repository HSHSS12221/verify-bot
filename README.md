# HSH SovereignSoul Discord Bot

Standalone Discord bot service for player verification, bilingual guides, and approval DMs. It shares the existing Supabase project and `whitelists` table with the HSH admin web service.

## What it does

- Posts one Verify panel containing exactly three buttons: Thai verification, English verification, and Guide.
- Collects a nickname, SteamID64, and the Discord ID of the account that pressed the button.
- Stores submissions in `whitelists` as `pending`. The web admin must approve them before the launcher allows the account into the game.
- Shows three editable guide steps for Thai and three for English. Each step has a title, text, and optional HTTPS image URL.
- Restricts `/control` and its editing buttons to the guild owner, members with Administrator permission, or configured admin role IDs.
- Accepts a private approval callback from the web service and sends `Owner has approve your whitelist!!` as a Discord DM.

The SteamID is entered by the player and is not proof of Steam account ownership. Check ownership before approving a request. If a player blocks DMs, whitelist approval still succeeds and the web page reports that the DM could not be delivered.

## Run locally

1. Run the parent web project's `schema.sql` in the Supabase SQL Editor. This creates the whitelist, bot settings, and guide tables.
2. Copy `.env.example` to `.env` and fill in Supabase and Discord values. Generate a long random `BOT_WEBHOOK_SECRET`.
3. In the Discord Developer Portal, create the application and bot. Invite it to your server using the `bot` and `applications.commands` OAuth scopes. Allow View Channel, Send Messages, and Embed Links in the verification channel.
4. Run `npm install`, then `npm start`.
5. In the Discord server, run `/control`, choose the verification channel, and save the six guide pages.

## Deploy as a separate Render Web Service

Create another Render **Web Service** using this repository with Root Directory `outputs/hsh-discord-bot`, Build Command `npm install`, and Start Command `npm start`. Use Node 24.17 or newer. Set the variables from `.env.example` in the bot service. Use the same `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as the web service, but keep the bot token only in this service.

On the web service, set:

- `DISCORD_BOT_API_URL` to this bot service's URL (prefer Render's private service URL when both services are in the same workspace/region).
- `DISCORD_BOT_WEBHOOK_SECRET` to exactly the same random value as the bot's `BOT_WEBHOOK_SECRET`.

The bot exposes `GET /health` and a secret-protected `POST /internal/approved`. Do not share the webhook secret. The bot registers the guild-specific `/control` command on startup.

## Guide images

In `/control`, open one of the six guide buttons and enter a title, instructions, and optional image URL. To use an image file, upload it to Discord first and paste its HTTPS image link into the guide editor.
