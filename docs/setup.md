# Setup — Phase 1 (Discord bot, running on your PC)

You need **Node.js 22.12 or newer** (`node -v`). On Windows install the LTS from
<https://nodejs.org>.

## 1. Create the Discord application and bot

1. Open <https://discord.com/developers/applications> → **New Application** → name it `SoundBridge`.
2. **General Information** → copy **Application ID** → this is `DISCORD_CLIENT_ID`.
3. **Bot** tab:
   * **Reset Token** → copy it → this is `DISCORD_TOKEN`. Treat it like a password.
   * Turn **Public Bot** *off* (so only you can invite it).
   * Privileged Gateway Intents: leave all **off** — SoundBridge doesn't need them.
4. Invite the bot to your server (replace `YOUR_APP_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=3146752
   ```

   `3146752` = View Channels + Connect + Speak. Nothing else.

## 2. Get your server and user IDs

Discord → User Settings → Advanced → enable **Developer Mode**. Then:

* right-click your server icon → **Copy Server ID** → `DISCORD_GUILD_ID`
* right-click your own name → **Copy User ID** → put it in `ALLOWED_USER_IDS`
  (comma-separate several friends' IDs if they should control it too)

## 3. Configure and install

```bash
git clone <your repo> soundbridge
cd soundbridge
npm install
cp .env.example server/.env      # Windows PowerShell: Copy-Item .env.example server/.env
# edit server/.env and fill in the values
```

## 4. Register slash commands (once, and whenever commands change)

```bash
npm run deploy-commands
```

Expected: `Registered 5 slash commands in guild …`.

## 5. Run the bot

```bash
npm run dev      # development: restarts on file changes
# or
npm run build && npm start
```

Expected log: `Logged in as SoundBridge#1234` and `Serving guild "…"`.

## 6. Phase 1 test checklist

| Test | Expected |
|---|---|
| Type `/` in your server | `/join`, `/leave`, `/stop`, `/status`, `/help` show up |
| Join a voice channel, run `/join` | Bot appears in the channel (deafened icon), reply "Joined …" |
| `/join channel:<other channel>` | Bot moves to that channel |
| `/status` | Shows channel, connection `ready`, player `idle` |
| `/stop` | "Nothing is playing right now." (no audio until Phase 4) |
| `/leave` | Bot leaves |
| `/join`, then everyone leaves the channel | Bot leaves by itself after ~60 s |
| Drag the bot to another channel in Discord | It stays connected; `/status` shows the new channel |
| Disconnect the bot via right-click → Disconnect | It leaves cleanly, `/status` says not connected |
| A user **not** in `ALLOWED_USER_IDS` runs `/join` | "You're not allowed to control SoundBridge." |
| Ctrl+C the bot | Leaves voice and exits |

### Troubleshooting

* `Invalid configuration` — a value in `server/.env` is missing or not a numeric ID.
* `Used disallowed intents` — you enabled nothing? Good. This error means the code asks
  for a privileged intent; it shouldn't. Report it.
* `Could not connect to the voice channel within 20 seconds` — check the bot role has
  Connect + Speak in that channel; corporate/school networks sometimes block Discord voice UDP.
* Commands don't appear — re-run `npm run deploy-commands`, check `DISCORD_GUILD_ID`,
  and make sure the invite URL included `applications.commands`.
* Run `npm run voice-report -w server` to see voice dependencies. You should see
  `native crypto support for aes-256-gcm: yes` and `@snazzah/davey` (Discord's
  required voice end-to-end encryption, "DAVE"). No Opus library or FFmpeg is needed:
  the browser will send ready-made Opus packets.
