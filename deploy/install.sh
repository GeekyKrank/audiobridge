#!/usr/bin/env bash
# Installs or updates SoundBridge on Ubuntu (Oracle Cloud Always Free friendly).
# Safe to re-run: it updates code, rebuilds and restarts.
#
#   cd ~/soundbridge && sudo DOMAIN=yourname.duckdns.org bash deploy/install.sh
#
# What it does:
#   1. adds 1 GB swap if the VM has < 2 GB RAM and no swap (builds need it)
#   2. installs Node.js 22 (NodeSource) and Caddy (official repo) if missing
#   3. copies the app to /opt/soundbridge, builds it, runs it as user 'soundbridge'
#   4. installs the systemd service (auto-start, auto-restart, logs in journald)
#   5. configures Caddy for HTTPS/WSS on $DOMAIN
#   6. opens ports 80/443 in the VM firewall (iptables or ufw); nothing else
set -euo pipefail

APP_DIR=/opt/soundbridge
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"

log() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."
[[ -n "${DOMAIN:-}" ]] || die "Set DOMAIN, e.g. sudo DOMAIN=myname.duckdns.org bash deploy/install.sh"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "DOMAIN looks invalid: $DOMAIN"
# shellcheck source=/dev/null
. /etc/os-release
[[ "$ID" == "ubuntu" ]] || warn "Tested on Ubuntu; this is $PRETTY_NAME."

# ---------- 1. swap ----------
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if (( mem_mb < 2000 )) && ! swapon --show | grep -q .; then
  log "Adding 1 GB swap (RAM is ${mem_mb} MB)"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------- 2. packages ----------
export DEBIAN_FRONTEND=noninteractive
need_node=1
if command -v node >/dev/null; then
  v=$(node -p 'process.versions.node')
  IFS=. read -r maj min _ <<<"$v"
  if (( maj > 22 || (maj == 22 && min >= 12) )); then need_node=0; fi
fi
if (( need_node )); then
  log "Installing Node.js 22"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node $(node -v)"

if ! command -v caddy >/dev/null; then
  log "Installing Caddy"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

# ---------- 3. app ----------
id soundbridge >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin soundbridge
mkdir -p "$APP_DIR"
log "Copying app to $APP_DIR"
ENV_FILE="$APP_DIR/server/.env"
saved_env=""
if [[ -f "$ENV_FILE" ]]; then saved_env=$(mktemp); cp -p "$ENV_FILE" "$saved_env"; fi
# Replace the code (keep recordings and npm cache), then restore the .env.
find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name recordings ! -name .npm -exec rm -rf {} +
tar -C "$SRC_DIR" \
  --exclude=node_modules --exclude=.git --exclude=./server/dist --exclude=./server/.env \
  --exclude=./extension --exclude=./docs/screenshots --exclude=./recordings \
  -cf - . | tar -C "$APP_DIR" -xf -
if [[ -n "$saved_env" ]]; then mv "$saved_env" "$ENV_FILE"; fi

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$SRC_DIR/server/.env" ]]; then
    cp "$SRC_DIR/server/.env" "$ENV_FILE"
  else
    cp "$APP_DIR/.env.example" "$ENV_FILE"
    token=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
    sed -i "s|^ACCESS_TOKEN=.*|ACCESS_TOKEN=$token|; s|^TRUST_PROXY=.*|TRUST_PROXY=true|; s|^HOST=.*|HOST=127.0.0.1|" "$ENV_FILE"
    warn "Created $ENV_FILE with a fresh ACCESS_TOKEN. Fill in the Discord values:"
    warn "  sudo nano $ENV_FILE   then re-run this script."
  fi
fi
chown -R soundbridge:soundbridge "$APP_DIR"
chmod 600 "$ENV_FILE"

log "Installing dependencies and building (takes a minute on a micro VM)"
cd "$APP_DIR"
sudo -u soundbridge -H npm ci --no-audit --no-fund --loglevel=error
sudo -u soundbridge -H npm run build --silent

discord_ready=1
grep -qE '^DISCORD_TOKEN=$' "$ENV_FILE" && discord_ready=0
if (( discord_ready )); then
  # Before the prune below: the registration script runs through tsx (a dev dependency).
  sudo -u soundbridge -H bash -c "cd $APP_DIR/server && npm run deploy-commands --silent" || warn "Slash command registration failed (check the Discord values)."
fi
sudo -u soundbridge -H npm prune --omit=dev --no-audit --no-fund --loglevel=error

# ---------- 4. service ----------
NODE_BIN=$(command -v node)
sed "s|/usr/bin/node|$NODE_BIN|" "$APP_DIR/deploy/soundbridge.service" > /etc/systemd/system/soundbridge.service
chmod 644 /etc/systemd/system/soundbridge.service
systemctl daemon-reload
systemctl enable soundbridge >/dev/null 2>&1

if (( discord_ready )); then
  start_service=1
  systemctl restart soundbridge
else
  warn "DISCORD_TOKEN is empty in $ENV_FILE - not starting the service yet."
  start_service=0
fi

# ---------- 5. Caddy ----------
log "Configuring Caddy for https://$DOMAIN"
# Our site lives in its own file and the main Caddyfile only imports it, so sites
# that this Caddy already serves for other apps are kept.
CADDYFILE=/etc/caddy/Caddyfile
SITE_FILE=/etc/caddy/soundbridge.caddy
IMPORT_LINE="import $SITE_FILE"
mkdir -p /etc/caddy /var/log/caddy && chown caddy:caddy /var/log/caddy
[[ -f $CADDYFILE && ! -f $CADDYFILE.before-soundbridge ]] && cp -p "$CADDYFILE" "$CADDYFILE.before-soundbridge"
caddy_backup=""
if [[ -f $CADDYFILE ]]; then caddy_backup=$(mktemp); cp -p "$CADDYFILE" "$caddy_backup"; fi
site_backup=""
if [[ -f $SITE_FILE ]]; then site_backup=$(mktemp); cp -p "$SITE_FILE" "$site_backup"; fi
sed -e "s|__DOMAIN__|$DOMAIN|" -e "s|__PORT__|$PORT|" "$APP_DIR/deploy/Caddyfile.template" > "$SITE_FILE"
chmod 644 "$SITE_FILE"
if [[ ! -f $CADDYFILE ]] || grep -q '/usr/share/caddy' "$CADDYFILE" || grep -q 'soundbridge\.log' "$CADDYFILE"; then
  # Stock Caddyfile (placeholder page) or one written by an older version of this script.
  echo "$IMPORT_LINE" > "$CADDYFILE"
elif ! grep -qxF "$IMPORT_LINE" "$CADDYFILE"; then
  log "Keeping the existing sites in $CADDYFILE and adding SoundBridge next to them"
  printf '\n%s\n' "$IMPORT_LINE" >> "$CADDYFILE"
fi
if ! caddy validate --adapter caddyfile --config "$CADDYFILE" >/dev/null 2>&1; then
  if [[ -n $caddy_backup ]]; then mv "$caddy_backup" "$CADDYFILE"; fi
  if [[ -n $site_backup ]]; then mv "$site_backup" "$SITE_FILE"; else rm -f "$SITE_FILE"; fi
  die "Caddy rejected the new config; restored the previous one. Details: caddy validate --config $CADDYFILE"
fi
for f in "$caddy_backup" "$site_backup"; do if [[ -n $f ]]; then rm -f "$f"; fi; done
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# ---------- 6. firewall (VM level; the Oracle Security List is separate!) ----------
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  log "Opening 80/443 in ufw"
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
elif iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  # Oracle's Ubuntu images ship iptables rules that REJECT everything except SSH.
  for p in 80 443; do
    # Skip if any ACCEPT rule already covers the port (also "--dports 80,443" style).
    if ! iptables -S INPUT | grep -- '-j ACCEPT' | grep -qE -- "--dports? ([0-9,:]*,)?$p(,|[[:space:]]|$)"; then
      log "Opening port $p in iptables"
      line=$(iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')
      iptables -I INPUT "$line" -p tcp --dport "$p" -m state --state NEW -j ACCEPT
    fi
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1; fi
fi

# ---------- summary ----------
echo
log "Done."
if (( start_service )); then
  sleep 2
  systemctl --no-pager --lines=8 status soundbridge || true
fi
cat <<MSG

Next steps:
  * Oracle Console -> Networking -> your VCN -> Security List: add Ingress rules
    for TCP 80 and 443 from 0.0.0.0/0 (needed once, for HTTPS certificates and the extension).
  * Check:   curl https://$DOMAIN/health
  * Logs:    journalctl -u soundbridge -f
  * Extension settings: Server URL = https://$DOMAIN
                        Access token = ACCESS_TOKEN from $ENV_FILE
MSG
