# Roadmap

| # | Phase | Status |
|---|---|---|
| 1 | Discord bot: login, `/join /leave /stop /status /help`, auto-leave, reconnect | ✅ built · needs live Discord test |
| 2 | Extension: tab list, tabCapture via offscreen doc, local monitoring, Opus encoding | ✅ built · engine verified in Chromium; real tabCapture needs your click |
| 3 | Local streaming: protocol, WebSocket ingest, auth, limits, `.ogg` recorder | ✅ built · verified end-to-end (automated) |
| 4 | Discord playback: jitter buffer → `@discordjs/voice` without transcoding | ✅ built · verified with the real AudioPlayer; live voice needs your test |
| 5 | Oracle deployment: install script, systemd, Caddy HTTPS/WSS, firewall, logs | ✅ scripts built · app part verified on Ubuntu 24.04; needs your VM |
| 6 | Browser → Oracle: settings, status, reconnect, single session | ✅ built · reconnect verified (automated) |
| 7 | Sync: pause/resume via loudness, track/seek, tab close, metadata (tab title) | ✅ built · pause/resume verified (automated) |
| 8 | UI polish: dark UI, status, stats, settings, errors, quality presets | ✅ built |

See [testing.md](testing.md) for what is verified automatically and what you need to
check by hand.

## Known limitations

* Chrome only allows capturing a tab after you invoke SoundBridge on it (icon, Alt+Shift+S,
  or right-click menu). Picking an arbitrary background tab from the list works only if
  SoundBridge was opened on it before.
* DRM-protected players may capture as silence; not bypassed by design.
* Metadata is the tab title/site/favicon, not per-site track parsing.
* One stream at a time (personal use). The server code is structured (hub + sinks)
  so multiple sessions could be added later.

## Future ideas (not started)

Multiple tabs/sources, Discord buttons for the browser player, album art via Media
Session (needs host permissions), web dashboard, session history, Opus FEC for lossy
networks, optional direct mode without the cloud relay.
