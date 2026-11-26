# Deploying to Oracle Cloud (Ubuntu)

Target: the existing Always Free VM (e.g. VM.Standard.E2.1.Micro, 1 OCPU, 1 GB RAM,
Frankfurt). Measured footprint: ~100 MB RAM, near-zero CPU while streaming (packets
are forwarded, never transcoded), ~17 KB/s inbound per stream.

## 0. Inspect the server first (read-only)

```bash
ssh ubuntu@<your-vm-ip>
git clone https://github.com/GeekyKrank/audiobridge.git soundbridge
cd soundbridge && git checkout ccr-db9dfb71-7eamay
sudo bash deploy/inspect-server.sh
```

It prints OS, CPU/RAM/disk, installed software, open ports, firewall rules and the
public IP. **Send the output to Claude before installing** if anything looks unusual
(other web servers on 80/443, very little disk, ARM CPU, an old Ubuntu, etc.).

## 1. A domain name (needed for HTTPS/WSS)

Chrome extensions must talk to a remote server over `https://`/`wss://`, and a free
certificate needs a domain name. Free option:

1. <https://www.duckdns.org> → sign in → create e.g. `mysoundbridge` → set its IP to the
   VM's public IP → you get `mysoundbridge.duckdns.org`.

(Any domain you own works too: an `A` record pointing to the VM's IP.)

## 2. Open ports 80 and 443 in Oracle Cloud

Oracle Console → **Networking → Virtual Cloud Networks** → your VCN → **Security
Lists** → Default Security List → **Add Ingress Rules**:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(Port 22 for SSH is already there. Nothing else is needed — the Node server itself is
never exposed.)

## 3. Install

```bash
cd ~/soundbridge
sudo DOMAIN=mysoundbridge.duckdns.org bash deploy/install.sh
```

First run creates `/opt/soundbridge/server/.env` with a fresh `ACCESS_TOKEN` and
stops before starting the bot. Fill in Discord values:

```bash
sudo nano /opt/soundbridge/server/.env
#   DISCORD_TOKEN=..., DISCORD_CLIENT_ID=..., DISCORD_GUILD_ID=..., ALLOWED_USER_IDS=...
#   EXTENSION_ID=<id from chrome://extensions>   (recommended)
sudo DOMAIN=mysoundbridge.duckdns.org bash deploy/install.sh    # run again
```

The script (idempotent, safe to re-run for updates):

1. adds 1 GB swap on small VMs (TypeScript build needs it),
2. installs Node.js 22 (NodeSource) and Caddy (official repo) if missing,
3. copies the app to `/opt/soundbridge`, builds, removes dev dependencies,
4. installs `soundbridge.service` (systemd: auto-start on boot, restart on crash,
   memory cap, hardening) and registers slash commands,
5. writes `/etc/caddy/Caddyfile` for your domain (old one backed up) — Caddy gets
   and renews the Let's Encrypt certificate automatically,
6. opens 80/443 in the VM firewall (Oracle images block them with iptables by default).

If you run the bot on your PC too, stop it there: one bot token = one running bot.

## 4. Check

```bash
curl https://mysoundbridge.duckdns.org/health      # {"ok":true,...}
systemctl status soundbridge
journalctl -u soundbridge -f                        # live logs (Ctrl+C to exit)
sudo grep ACCESS_TOKEN /opt/soundbridge/server/.env # for the extension
```

Extension Settings → Server URL `https://mysoundbridge.duckdns.org`, Access token as
above → **Test connection** → **Save**.

## Updating

```bash
cd ~/soundbridge && git pull && sudo DOMAIN=mysoundbridge.duckdns.org bash deploy/install.sh
```
Then reload the extension on `chrome://extensions` if extension files changed.

## Operations

| Task | Command |
|---|---|
| Logs | `journalctl -u soundbridge -f` (`--since "1 hour ago"`) |
| Restart | `sudo systemctl restart soundbridge` |
| Stop / disable | `sudo systemctl stop soundbridge` / `sudo systemctl disable soundbridge` |
| Caddy logs | `sudo tail -f /var/log/caddy/soundbridge.log` |
| Rotate the access token | edit `ACCESS_TOKEN` in `.env`, restart, update the extension |
| Debug recording | set `RECORD_DIR=/opt/soundbridge/recordings` in `.env`, `sudo mkdir -p` it, `chown soundbridge`, restart |

## Troubleshooting

* `curl` to the domain hangs → ports 80/443 not open in the Oracle Security List,
  or DuckDNS IP is wrong.
* Caddy log says it can't get a certificate → same as above (Let's Encrypt must reach
  port 80/443), or the domain doesn't point to this VM yet.
* `systemctl status` shows `Invalid configuration` → fix `/opt/soundbridge/server/.env`.
* Out of memory during install → the script adds swap; check `free -h`.
