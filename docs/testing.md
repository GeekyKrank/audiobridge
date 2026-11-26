# Test checklist

## Automated (run on any machine with Node 22 + ffmpeg)

```bash
npm test          # 20 server tests: protocol, validation, jitter buffer, real
                  # @discordjs/voice AudioPlayer, Ogg output, HTTP/WebSocket security
npm run e2e       # needs Playwright + Chromium: real browser audio engine -> server ->
                  # recorded .ogg checked with ffmpeg; pause, resume, server restart,
                  # extension loads, popup renders
```

What automated tests **cannot** cover (needs you): real Discord voice, real
`chrome.tabCapture` on a real tab (Chrome requires a human click), Oracle networking.

## Manual — Discord bot

| # | Do | Expect |
|---|---|---|
| 1 | Type `/` in your server | `/join /leave /stop /status /help` |
| 2 | In a voice channel: `/join` | Bot joins (deafened) |
| 3 | `/join channel:<other>` | Bot moves |
| 4 | `/status` | Channel, connection `ready` |
| 5 | `/leave` | Bot leaves |
| 6 | Someone not in `ALLOWED_USER_IDS` runs `/join` | Refused |
| 7 | Everyone leaves the channel | Bot leaves after ~60 s |

## Manual — sharing

| # | Do | Expect |
|---|---|---|
| 1 | SoundCloud tab, click icon, **Share Audio** | Bot joins, friends hear the music, badge `ON`, you still hear it |
| 2 | Pause SoundCloud | After ~1.5 s Discord stops (bot's green ring off), badge `❚❚`, popup "Paused" |
| 3 | Play | Music returns within ~0.5 s |
| 4 | Next track / seek | Friends hear the new track / new position |
| 5 | Change SoundCloud's volume slider | Friends hear it louder/quieter |
| 6 | Settings → Local volume 0 | You hear nothing, friends still do |
| 7 | `/status` in Discord | Shows the track title, `playing`, bitrate |
| 8 | Close the SoundCloud tab | Sharing stops, popup says the tab was closed |
| 9 | Share again, then turn Wi-Fi off for 5 s and back on | Popup "Reconnecting", then live again |
| 10 | Share in a second tab while the first is shared | Popup asks to stop first; via Alt+Shift+S it switches tabs |
| 11 | `/stop` in Discord | Sharing ends in the extension too |
| 12 | Play Deadlock while sharing for 10 min | No FPS change, no audio drift (delay stays ~constant) |
| 13 | Task Manager → Chrome "Extension: SoundBridge" | ~1–2 % CPU, < 100 MB |
