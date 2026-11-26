# SoundBridge architecture

## Goal

Stream the *actual audio of one Chrome tab* into a Discord voice channel through a
bot on my own Oracle Cloud VPS. Only the chosen tab is captured — never the game,
Discord itself, or the desktop.

```
 Windows PC (Chrome)                          Oracle VPS (1 process, Node.js)              Discord
┌──────────────────────────────┐   WSS      ┌───────────────────────────────────┐  voice  ┌──────────┐
│ SoundCloud tab               │  binary    │ ingest (WebSocket, auth, limits)  │  UDP    │ voice    │
│   │ chrome.tabCapture        │  Opus      │   │ jitter buffer (~300–600 ms)   │ ──────► │ channel  │
│   ▼                          │  packets   │   ▼                               │         │ friends  │
│ offscreen document           │ ─────────► │ Readable of Opus packets          │         └──────────┘
│   ├─► AudioContext → speakers│            │   ▼                               │
│   └─► WebCodecs AudioEncoder │            │ @discordjs/voice AudioPlayer      │
│        (Opus 48k stereo 20ms)│            │   (StreamType.Opus: no transcode) │
│ popup UI / service worker    │            │ discord.js bot + slash commands   │
└──────────────────────────────┘            └───────────────────────────────────┘
```

The bot and the ingest server run in **one Node.js process**: on a 1 vCPU / 1 GB
VM, one process (~80–120 MB RSS) is cheaper than two plus an IPC layer, and the
"WebSocket → voice player" hand-off is just an in-memory stream.

## Components

| Part | Where | Tech |
|---|---|---|
| Extension (popup, service worker, offscreen doc) | Chrome on Windows | Manifest V3, `chrome.tabCapture`, `chrome.offscreen`, WebCodecs |
| Ingest server | VPS | Node 22, TypeScript, `ws` |
| Discord bot | VPS (same process) | `discord.js` 14, `@discordjs/voice` 0.19 |
| Reverse proxy / TLS | VPS | Caddy (automatic Let's Encrypt) — Phase 5 |

## Audio pipeline decision

Discord voice *is* Opus: 48 kHz, stereo, 20 ms frames. If the browser produces
exactly that, the server never decodes or re-encodes anything — it just forwards
packets. That is the single most important choice for a 1-CPU server.

### Options considered

| Option | Verdict |
|---|---|
| Raw PCM over WebSocket | ~1.5 Mbit/s up, server must Opus-encode (CPU). Rejected. |
| `MediaRecorder` (`audio/webm;codecs=opus`) → server demuxes WebM | Works, but MediaRecorder batches into chunks (≥ ~100–250 ms timeslices) and the container adds parsing. **Kept as fallback** (prism-media ships a WebM demuxer). |
| **WebCodecs `AudioEncoder` (Opus) → raw packets over WSS** | One packet per 20 ms, no container, exact Discord format, browser encoder runs natively. **Chosen.** |
| WebRTC to server | Lowest latency, but needs a server-side WebRTC stack (ICE/DTLS/SRTP — e.g. mediasoup/werift): heavy, complex, extra UDP ports. Overkill for 1–3 s target. Possible later. |
| FFmpeg on server | Only needed if we transcode. Not needed in the chosen design. |

### Chosen format

| Parameter | Value |
|---|---|
| Codec | Opus (WebCodecs `AudioEncoder`, `application: "audio"`) |
| Sample rate | 48 000 Hz |
| Channels | 2 (stereo) |
| Frame / packet duration | 20 ms (50 packets/s) |
| Bitrate | 128 kbit/s default (64–192 selectable). Discord channels default to 64 kbit/s and go up to 96 (or higher with Server Boost); sending more than the listener's client plays back is wasted upload. |
| Transport | WSS binary messages, one Opus packet each + small header (sequence number, timestamp) |
| Upload bandwidth | ≈ 128 kbit/s + ~10 kbit/s overhead ≈ 17 KB/s |
| Server buffer | jitter buffer target 300–600 ms (configurable), drops oldest when over a hard cap |

### Latency budget (MVP target: under ~1 s, 1–3 s acceptable)

encode 20 ms + network to Frankfurt 20–40 ms + jitter buffer 300–600 ms +
Discord's own path ~100–200 ms. TCP head-of-line blocking is the main risk of
WebSocket; the jitter buffer absorbs it. This can be tuned down later.

### Pause / resume / seek / track change

The browser stays the source of truth. A captured tab track keeps delivering
frames while paused (silence), so: pause ⇒ silence is sent (Opus silence is tiny,
and the server can stop "speaking" after a run of silent frames); resume, seek,
track change ⇒ whatever the tab plays next is what gets encoded. No site APIs,
no downloading, no Discord commands needed. Tab closed ⇒ the track ends, the
extension sends `stop`, the server ends the stream.

### Keeping the tab audible

`tabCapture` mutes the tab locally while captured. The offscreen document routes
the captured stream into an `AudioContext` → `destination` so you still hear it
(the "local monitoring" setting).

## Security model

* Bot token lives only in `server/.env` on the VPS. The extension never sees it.
* Extension authenticates with a long random **access token** (shared secret) on
  WebSocket upgrade; unauthenticated upgrades are rejected before any audio is read.
* WSS only in production (Caddy terminates TLS). Node listens on `127.0.0.1` only.
* Firewall: only 22 (SSH), 80/443 (Caddy) open — both in the Oracle security list
  and the VM's iptables/ufw.
* Ingest validates every message: max message size, max packets/s, expected header.
* One active stream per guild; a new authenticated connection replaces the old one
  (prevents duplicates after reconnect).
* Slash commands only work in the configured guild and optionally only for
  `ALLOWED_USER_IDS`.

## Repository layout

```
soundbridge/
├── server/            # Node.js: Discord bot + (Phase 3+) audio ingest
│   ├── src/
│   │   ├── config/    # env validation
│   │   ├── discord/   # client, voice manager, slash commands
│   │   └── util/      # logger
│   └── scripts/       # deploy-commands
├── extension/         # Phase 2+: Chrome MV3 extension
├── shared/            # Phase 3+: wire protocol types shared by both
└── docs/
```
