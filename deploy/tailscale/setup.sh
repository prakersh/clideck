#!/usr/bin/env bash
# One-shot installer for clideck behind Tailscale HTTPS.
#
# Requirements (checked below):
#   - Running as root (or via sudo)
#   - tailscale installed, logged in, and online
#   - Node.js 18+
#   - MagicDNS + HTTPS certificates enabled in the tailnet admin UI
#
# What it does:
#   1. Derives the host's tailnet FQDN and IPv4 from `tailscale status`.
#   2. Issues a Let's Encrypt cert via `tailscale cert`.
#   3. Installs clideck globally via npm (if missing).
#   4. Writes /etc/clideck/clideck.env with production settings.
#   5. Installs a systemd unit and starts the service.
#
# Does not touch user dotfiles, the tailnet config, or firewall rules.

set -euo pipefail

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!!\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || die "run as root (sudo bash setup.sh)"
command -v tailscale >/dev/null || die "tailscale not installed"
command -v node       >/dev/null || die "node not installed (need Node 18+)"
command -v npm        >/dev/null || die "npm not installed"

# Node version check
node_major=$(node -p 'process.versions.node.split(".")[0]')
[[ $node_major -ge 18 ]] || die "Node 18+ required (have $(node -v))"

# Tailscale must be up
tailscale status >/dev/null 2>&1 || die "tailscale is not running — run \`sudo tailscale up\` first"

# Derive FQDN + IP
FQDN=$(tailscale status --json | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const j=JSON.parse(s);
    process.stdout.write((j.Self.DNSName||"").replace(/\.$/, ""));
  })')
TSIP=$(tailscale ip -4 | head -1)

[[ -n $FQDN ]] || die "could not derive tailnet FQDN (is MagicDNS enabled?)"
[[ -n $TSIP ]] || die "could not derive tailnet IPv4"

info "tailnet FQDN: $FQDN"
info "tailnet IPv4: $TSIP"

# Install clideck if missing (or upgrade)
if ! command -v clideck >/dev/null; then
  info "installing clideck via npm (global)"
  npm install -g clideck
else
  info "clideck already installed: $(clideck --version 2>/dev/null || echo '?')"
fi

# Issue cert
install -d -m 755 /etc/clideck
install -d -m 750 /etc/clideck/tls

info "requesting Tailscale certificate for $FQDN"
pushd /etc/clideck/tls >/dev/null
  tailscale cert "$FQDN" \
    || die "tailscale cert failed — enable HTTPS certificates in the Tailscale admin UI (DNS tab)"
  # tailscale writes <fqdn>.crt and <fqdn>.key
  mv -f "${FQDN}.crt" fullchain.pem
  mv -f "${FQDN}.key" privkey.pem
  chmod 600 privkey.pem
popd >/dev/null

# Prompt for credentials
read -rp "Choose an admin username: " USERNAME
USERNAME=${USERNAME:-admin}
# Generate a strong password if the user just hits enter
read -rsp "Choose an admin password (blank → generated): " PASSWORD
echo
if [[ -z $PASSWORD ]]; then
  PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')
  info "generated password: $PASSWORD"
  warn "save this password somewhere safe — it will not be shown again"
fi

# Write env file
info "writing /etc/clideck/clideck.env"
cat > /etc/clideck/clideck.env <<EOF
CLIDECK_HOST=$TSIP
CLIDECK_PORT=443
CLIDECK_TLS_CERT_PATH=/etc/clideck/tls/fullchain.pem
CLIDECK_TLS_KEY_PATH=/etc/clideck/tls/privkey.pem
CLIDECK_ALLOWED_ORIGINS=https://$FQDN
CLIDECK_PUBLIC_MODE=1
CLIDECK_USERNAME=$USERNAME
CLIDECK_PASSWORD=$PASSWORD
CLIDECK_COOKIE_SECURE=1
EOF
chmod 600 /etc/clideck/clideck.env

# Let node bind :443 without running as root
info "granting cap_net_bind_service to node"
setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"

# Install systemd unit
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/clideck.service"
if [[ ! -f $UNIT_SRC ]]; then
  # Fall back to downloading from main (for the curl | bash path)
  UNIT_SRC=$(mktemp)
  curl -fsSL https://raw.githubusercontent.com/prakersh/clideck/main/deploy/tailscale/clideck.service -o "$UNIT_SRC"
fi

install -m 644 "$UNIT_SRC" /etc/systemd/system/clideck.service
systemctl daemon-reload
systemctl enable --now clideck

sleep 2
if systemctl is-active --quiet clideck; then
  info "clideck is running"
else
  warn "clideck did not start cleanly — check: journalctl -u clideck -n 50"
fi

echo
info "open this on your phone (while connected to the tailnet):"
echo
echo "    https://$FQDN/"
echo
info "login: $USERNAME"
info "to rotate the cert, re-run: sudo tailscale cert $FQDN (see cert-renew.service)"
