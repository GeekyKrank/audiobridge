# Roadmap

Each phase ends with something you can test by hand. We don't start the next
phase until the current one works.

| # | Phase | Deliverable | Test | Status |
|---|---|---|---|---|
| 1 | Discord bot | Bot logs in; `/join` `/leave` `/stop` `/status` `/help`; auto-leave empty channel | Bot joins/leaves your voice channel | **Code done — needs your test** |
| 2 | Local tab capture | MV3 extension: tab list, capture via offscreen doc, local monitoring, sharing indicator, WebCodecs Opus encoder producing packets (counted, not sent) | Tab stays audible; packet counter rises ~50/s | Not started |
| 3 | Local streaming | `shared/` protocol, WebSocket ingest on `localhost` with token auth + limits; server writes received Opus to an `.ogg` file for verification | Recorded file sounds right incl. pause/resume | Not started |
| 4 | Discord playback | Ingest → jitter buffer → `AudioPlayer` (`StreamType.Opus`) | Friends hear the tab while running locally | Not started |
| 5 | Oracle deployment | Inspect VPS, Node 22, systemd service, Caddy WSS, firewall, logs | `wss://` reachable, bot auto-restarts | Not started |
| 6 | Browser → Oracle | Extension talks to WSS, status, reconnect, single-session | Full pipeline Chrome → Oracle → Discord | Not started |
| 7 | Sync & recovery | Silence detection, tab-close, network drop recovery, metadata (optional) | Pause/seek/track switch/close tab | Not started |
| 8 | UI polish | Final design, settings, error messages, quality presets | — | Not started |

Future ideas (only after 1–8 are stable): see the master prompt, section 13.
