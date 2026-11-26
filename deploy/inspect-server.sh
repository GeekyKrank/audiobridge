#!/usr/bin/env bash
# READ-ONLY inspection of the VPS before installing SoundBridge. Changes nothing.
# Run on the server:  bash deploy/inspect-server.sh   and send the output back.
set -u
section() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

section "System"
# shellcheck source=/dev/null
(. /etc/os-release && echo "$PRETTY_NAME") 2>/dev/null
uname -srm
echo "uptime: $(uptime -p 2>/dev/null)"

section "CPU / RAM / swap / disk"
echo "CPUs: $(nproc)"
grep -m1 'model name' /proc/cpuinfo 2>/dev/null || lscpu 2>/dev/null | grep -m1 'Model name'
free -h
df -h / | tail -1

section "Software"
for c in node npm git caddy nginx apache2 docker pm2 ffmpeg ufw iptables; do
  if have "$c"; then printf '%-8s %s\n' "$c" "$($c --version 2>/dev/null | head -1 || echo present)"; else printf '%-8s -\n' "$c"; fi
done

section "Listening ports"
(sudo -n ss -tulpn 2>/dev/null || ss -tuln) | sed 1d

section "Firewall"
if have ufw; then sudo -n ufw status 2>/dev/null || echo "ufw: need sudo to read"; fi
sudo -n iptables -S INPUT 2>/dev/null || echo "iptables: need sudo to read (run with sudo for full output)"

section "Running services (top memory)"
ps -eo pid,comm,%mem,rss --sort=-rss | head -12

section "Existing SoundBridge"
ls -la /opt/soundbridge 2>/dev/null || echo "not installed"
systemctl is-active soundbridge 2>/dev/null || true

section "Public IP (as seen from outside)"
curl -s --max-time 5 https://api.ipify.org || echo "unknown"
echo
