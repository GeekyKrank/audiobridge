# Setup on your PC (local test before Oracle)

Everything runs on your Windows PC first: the server on `localhost`, the extension in
Chrome, the bot in your Discord server. When this works, move the server to Oracle
([deployment.md](deployment.md)).

Requirements: **Node.js 22.12+** (`node -v`; LTS from <https://nodejs.org>), **Git**,
**Chrome 116+**.

## 1. Discord application and bot

1. <https://discord.com/developers/applications> → **New Application** → `SoundBridge`.
2. **General Information** → copy **Application ID** → `DISCORD_CLIENT_ID`.
3. **Bot** tab:
   * **Reset Token** → copy → `DISCORD_TOKEN` (a password — never share it).
   * **Public Bot**: off.
   * Privileged Gateway Intents: all **off** (not needed).
4. Invite the bot (replace `YOUR_APP_ID`):
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=3146752
   ```
   (`3146752` = View Channels + Connect + Speak.)
5. Discord → Settings → Advanced → **Developer Mode** on. Right-click your server →
   **Copy Server ID** → `DISCORD_GUILD_ID`. Right-click yourself → **Copy User ID** →
   `ALLOWED_USER_IDS`.

## 2. Server

```powershell
git clone https://github.com/GeekyKrank/audiobridge.git soundbridge
cd soundbridge
git checkout ccr-db9dfb71-7eamay      # until merged into main
npm install
npm run gen-token                      # prints a random ACCESS_TOKEN
Copy-Item .env.example server/.env     # macOS/Linux: cp .env.example server/.env
notepad server/.env                    # fill DISCORD_*, ALLOWED_USER_IDS, ACCESS_TOKEN
npm run deploy-commands                # registers /join /leave /stop /status /help
npm run dev                            # starts bot + server on http://localhost:8787
```

Expected log lines: `Listening on http://127.0.0.1:8787`, `Logged in as SoundBridge#…`,
`Serving guild "…"`.

## 3. Extension

1. Chrome → `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → choose the `extension` folder of the repo.
3. Pin SoundBridge (puzzle icon → pin).
4. Click the icon → Settings opens:
   * Server URL: `http://localhost:8787`
   * Access token: the `ACCESS_TOKEN` from `server/.env`
   * **Test connection** → should say "Connected … Bot: SoundBridge#… in <server>" → **Save**.
5. Optional hardening: copy the extension ID from `chrome://extensions` into
   `EXTENSION_ID=` in `server/.env` and restart the server.

## 4. Share

1. Join a voice channel in Discord.
2. Open SoundCloud (or YouTube…) and play something.
3. **On that tab**, click the SoundBridge icon → (optionally pick a voice channel) →
   **Share Audio**. Or press **Alt+Shift+S** on the tab.
4. The bot joins your channel; friends hear the tab. The badge on the icon shows `ON`.

Then go through [testing.md](testing.md).

## Local test without Discord

Set `DISCORD_ENABLED=false` and `RECORD_DIR=../recordings` in `server/.env`. Every share
is saved as an `.ogg` file you can open in VLC/Chrome to hear exactly what would be sent.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Invalid configuration` on start | The message lists the bad values in `server/.env`. |
| Popup: "Offline" | Server not running, or wrong Server URL. |
| Popup: "Wrong access token" | Token in the extension ≠ `ACCESS_TOKEN` in `server/.env`. |
| "Chrome needs you to open SoundBridge on that tab first" | Chrome rule: switch to that tab and click the icon there (or Alt+Shift+S). |
| "Pick a voice channel…" | Join a voice channel in Discord or choose one in the popup. |
| Bot joins but silent | Check `/status`: is the stream "playing"? Is the tab really playing (not muted in the site)? DRM-protected players may capture as silence. |
| You don't hear the tab yourself | Settings → "Hear the tab locally" on, Local volume up. |
| Choppy audio for friends | Raise Buffer in Settings (e.g. 800 ms), or lower Quality. |
| Commands don't show | `npm run deploy-commands`; invite link must include `applications.commands`. |
| `npm run voice-report -w server` | Should show `aes-256-gcm: yes` and `@snazzah/davey` (Discord's required voice encryption). No Opus library or FFmpeg needed. |
