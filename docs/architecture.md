# SoundBridge architecture

## Goal

Stream the *actual audio of one Chrome tab* into a Discord voice channel through a
bot on my own Oracle Cloud VPS. Only the chosen tab is captured — never the game,
Discord itself, or the desktop.

```
 Windows PC (Chrome)                            Oracle VPS (one Node.js process)                Discord
┌────────────────────────────────┐   WSS      ┌──────────────────────────────────────┐  voice  ┌─────────┐
│ popup (UI)  ⇄  service worker  │  binary    │ Caddy :443 (TLS) → 127.0.0.1:8787     │  UDP    │ voice   │
│                   │ tabCapture │  Opus      │ ├ HTTP API  /api/* (token, CORS)      │ ──────► │ channel │
│                   ▼ streamId   │  packets   │ └ WebSocket /ws (token, limits)       │         │ friends │
│ offscreen document             │ ─────────► │      ▼ StreamHub (one stream max)     │         └─────────┘
│  getUserMedia(tab) ─► speakers │            │      ▼ OpusJitterStream (≈400 ms)     │
│        └► AudioWorklet (20 ms) │            │      ▼ AudioPlayer, StreamType.Opus   │
│           └► AudioEncoder Opus │            │        (no decoding / re-encoding)    │
│              └► StreamClient   │            │ discord.js bot + slash commands       │
└────────────────────────────────┘            └──────────────────────────────────────┘
```

## Components

| Part | Files | Responsibility |
|---|---|---|
| Popup | `extension/src/popup/*` | Tab picker, Discord channel/join, Share button, live stats, settings |
| Service worker | `extension/src/background.js` | Gets the tab stream ID, owns the offscreen doc, tracks the shared tab (title/close), badge, shortcut, context menu. State in `chrome.storage.session` |
| Offscreen document | `extension/src/offscreen.js` | Lives while sharing: capture, local playback, encoder, WebSocket |
| Audio engine | `extension/src/audio/engine.js`, `capture-worklet.js` | 48 kHz AudioContext → worklet (exact 20 ms frames + loudness) → WebCodecs Opus |
| Stream client | `extension/src/net/stream-client.js` | Auth, start, audio send with back-pressure drop, ping/RTT, reconnect with backoff |
| Protocol | `shared/protocol.js` (+ `.d.ts`) | Packet format, close codes, limits; copied into the extension |
| Server | `server/src/net/server.ts` | HTTP API + WebSocket, auth, origin check, rate limits, heartbeat |
| Stream hub | `server/src/stream/hub.ts` | Single active stream, takeover, 15 s reconnect grace, stats |
| Discord sink | `server/src/stream/discord-sink.ts` | Picks/join channel, feeds jitter buffer into the voice player |
| Recorder sink | `server/src/stream/recorder-sink.ts` | Optional `.ogg` recording (`RECORD_DIR`) for testing |
| Bot | `server/src/discord/*` | Login, voice connections, slash commands, auto-leave |

## Audio pipeline decision

Discord voice *is* Opus: 48 kHz, stereo, 20 ms frames. The browser produces exactly
that, so the server only forwards packets. That's what keeps a 1-CPU VM idle.

| Option | Verdict |
|---|---|
| Raw PCM over WebSocket | ~1.5 Mbit/s upload and server-side encoding. Rejected. |
| `MediaRecorder` (WebM/Opus) | Chunked output (≥100 ms), needs WebM demuxing. Possible fallback, not needed. |
| **AudioWorklet + WebCodecs `AudioEncoder` (Opus) → WSS** | Exact 20 ms packets in Discord's format, native encoder. **Chosen.** |
| WebRTC | Needs a WebRTC stack on the server (ICE/DTLS/SRTP, UDP ports). Overkill for this. |
| FFmpeg on server | Only for transcoding, which we never do. |

| Parameter | Value |
|---|---|
| Codec | Opus via WebCodecs (`application: audio`, `signal: music` when supported) |
| Sample rate / channels | 48 000 Hz, stereo (AudioContext resamples 44.1 kHz sources) |
| Packet duration | 20 ms (50 packets/s), one packet per WebSocket message |
| Bitrate | 128 kbit/s default; 64 / 96 / 128 / 160 selectable |
| Packet header | 4 bytes: kind, flags (silent), uint16 sequence |
| Upload | ≈ 17 KB/s at 128 kbit/s |
| Client back-pressure | drop packets if > 48 KB is queued in the socket (never let delay grow) |
| Server buffer | jitter buffer target 400 ms (extension setting, 100–2000), hard cap 1500 ms (`MAX_BUFFER_MS`): over the cap, oldest packets are dropped back to target |
| Underrun | buffer re-fills to target before resuming; > 1 s without audio → player stops, restarts on next packet |

Measured in the automated browser test: 128 kbit/s, 0 sequence gaps; recorded output is
valid 48 kHz stereo Opus with the test tone intact.

**Latency** ≈ 20 ms frame + network (Frankfurt from Europe ~20–40 ms) + server
buffer (400 ms) + Discord (~100–200 ms) ≈ **0.6 s**. Lower the Buffer setting for less
delay, raise it if friends hear dropouts.

## Following the browser (pause, seek, track change)

The browser is the source of truth; no website APIs are used.

* **Pause**: the worklet measures loudness every 20 ms. After 1.5 s of silence the
  extension stops sending packets and tells the server `audible:false`; the server
  ends the playback pipe so the bot stops "speaking" (no stale audio, no hiss).
* **Resume / seek / next track**: whatever the tab plays is encoded next; the first
  loud packet restarts playback on Discord within the buffer time.
* **Volume**: capture happens after the page's own player volume, so the site's
  volume slider changes what friends hear. The "Local volume" setting only changes
  what *you* hear.
* **Tab closed / navigated away**: Chrome ends the capture; the service worker also
  watches `tabs.onRemoved`. Sharing stops and the popup says why. Navigation inside
  the tab keeps the capture (Chrome keeps it across navigations).
* **Metadata**: tab title, site and favicon (via `tabs`), sent as `meta` messages and
  shown in `/status`. No scraping.

## Reconnection and duplicates

* WebSocket drops → client retries after 1, 2, 4, 8, 15 s… and re-sends `start`.
* The server keeps the stream for 15 s after a drop (`RECONNECT_GRACE_MS`), so a
  quick reconnect resumes seamlessly; afterwards it stops the stream.
* Only one stream exists at a time. A new `start` replaces the old one and closes
  the old socket with code 4003, which the old client treats as final (no
  reconnect fight).
* Voice connection drops are retried by `@discordjs/voice`; if the bot is kicked it
  stays out until you press Join or use `/join`.

## Chrome restrictions that shape the UX

* `chrome.tabCapture.getMediaStreamId({targetTabId})` only works for tabs where the
  user has **invoked** the extension (clicked its icon there, used its shortcut, or its
  context menu). So the normal flow is: on the SoundCloud tab click the SoundBridge icon
  → Share Audio. The popup can list other tabs, and sharing one works if SoundBridge was
  opened on it before; otherwise the popup offers "Go to that tab".
  Keyboard: **Alt+Shift+S** toggles sharing of the current tab.
* Captured tabs are muted by Chrome; the offscreen document plays the audio back
  locally (the "Hear the tab locally" setting).
* DRM-protected playback (e.g. Spotify/Netflix with Widevine) may be captured as
  silence. SoundBridge does not try to bypass that.

## Security model

* Bot token only in `server/.env` on the VPS (mode 600, owned by the service user).
* Extension ↔ server: `ACCESS_TOKEN` (≥ 24 chars, constant-time compare) sent as the
  first WebSocket message and as `Authorization: Bearer` for the API. 10 failures per
  IP → blocked for 10 minutes.
* Browser origin check: only `chrome-extension://` origins (or exactly
  `EXTENSION_ID`) — ordinary websites can't talk to the server even from your browser.
* WSS/HTTPS through Caddy; Node listens on `127.0.0.1` only. Firewall: 22, 80, 443.
* Input validation: 8 KB message cap, 200 messages/s, strict JSON schemas, audio
  packet bounds (≤ 1275 bytes Opus), no compression (no zip bombs, less CPU).
* Slash commands: only in `DISCORD_GUILD_ID`, optionally only `ALLOWED_USER_IDS`.
* systemd hardening (no new privileges, read-only system, memory cap 350 MB).
