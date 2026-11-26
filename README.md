# SoundBridge

Share the audio of **one Chrome tab** (SoundCloud, YouTube, a podcast…) into a
Discord voice channel, through a bot on your own server. Your game audio and
Discord voice are never captured.

```
Chrome tab → tabCapture → Opus (WebCodecs) → WSS → your VPS → Discord bot → voice channel
```

* Not a music bot: it doesn't search or download anything. It forwards what your tab plays.
* Official bot account only (no self-bot).
* Lightweight: the server forwards Opus packets without transcoding.

## Status

| Phase | |
|---|---|
| 1. Discord bot (`/join` `/leave` `/stop` `/status` `/help`) | ✅ implemented, awaiting live test |
| 2–8. Extension, streaming, deployment, sync, UI | not implemented yet |

See [docs/roadmap.md](docs/roadmap.md).

## Docs

* [Architecture & audio design](docs/architecture.md)
* [Setup (Phase 1)](docs/setup.md)
* [Roadmap](docs/roadmap.md)

## Quick start (Phase 1)

```bash
npm install
cp .env.example server/.env   # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, ALLOWED_USER_IDS
npm run deploy-commands
npm run dev
```

Never commit `server/.env`. It's ignored by `.gitignore`.
