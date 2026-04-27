#!/usr/bin/env bash
# One-shot installer for clideck behind Tailscale HTTPS.
#
# Requirements (checked below):
#   - Running as root (or via sudo)
#   - tailscale installed, logged in, and online
#   - Node.js 18+
#   - MagicDNS + HTTPS certificates enabled in the tailnet admin UI
#
# What it does (idempotent — safe to re-run):
#   1. Derives the host's tailnet FQDN and IPv4 from `tailscale status`.
#   2. Creates a dedicated `clideck` system user with HOME=/var/lib/clideck.
#   3. Issues a Let's Encrypt cert via `tailscale cert` into /etc/clideck/tls/.
#   4. Installs clideck globally via npm (skipped if already installed).
#   5. Writes /etc/clideck/clideck.env with production settings — but ONLY
#      if it does not already exist (re-runs do not silently overwrite
#      credentials; delete the file to reset).
#   6. setcap on the resolved node binary so the unprivileged clideck user
#      can bind :443. Warns if node looks like an nvm/per-user install.
#   7. Installs the systemd unit and the cert-renewal timer, enables both.
#
# Does not touch user dotfiles, the tailnet config, or firewall rules.

set -euo pipefail

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!!\033[0m %s\n' "$*" >&2; }

[[ $EUID -eq 0 ]] || die "run as root (sudo bash setup.sh)"
command -v tailscale >/dev/null || die "tailscale not installed"
command -v node       >/dev/null || die "node not installed (need Node 18+)"
command -v npm        >/dev/null || die "npm not installed"
command -v setcap     >/dev/null || die "setcap not installed (apt install libcap2-bin)"

# Node version check
node_major=$(node -p 'process.versions.node.split(".")[0]')
[[ $node_major -ge 18 ]] || die "Node 18+ required (have $(node -v))"

# Tailscale must be up
tailscale status >/dev/null 2>&1 || die "tailscale is not running — run \`sudo tailscale up\` first"

# --- Derive FQDN + IP from tailscale ----------------------------------------
# `tailscale status --json` returns Self.DNSName with a trailing dot. Strip it.
FQDN=$(tailscale status --json | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    const j=JSON.parse(s);
    process.stdout.write((j.Self.DNSName||"").replace(/\.$/,""));
  })')
TSIP=$(tailscale ip -4 | head -1)

[[ -n $FQDN ]] || die "could not derive tailnet FQDN (is MagicDNS enabled in the tailnet admin UI?)"
[[ -n $TSIP ]] || die "could not derive tailnet IPv4"

info "tailnet FQDN: $FQDN"
info "tailnet IPv4: $TSIP"

# --- Dedicated system user --------------------------------------------------
if ! id -u clideck >/dev/null 2>&1; then
  info "creating clideck system user"
  useradd --system --create-home --home-dir /var/lib/clideck --shell /usr/sbin/nologin clideck
else
  info "clideck user already exists"
fi
install -d -o clideck -g clideck -m 750 /var/lib/clideck

# --- Install clideck if missing --------------------------------------------
if ! command -v clideck >/dev/null; then
  info "installing clideck via npm (global)"
  npm install -g clideck
else
  info "clideck already installed: $(clideck --version 2>/dev/null || echo '?')"
fi
CLIDECK_INSTALLED_VERSION=$(npm list -g clideck --json --depth=0 2>/dev/null | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{
    try{process.stdout.write(JSON.parse(s).dependencies.clideck.version||"")}catch{process.stdout.write("")}
  })')
[[ -n $CLIDECK_INSTALLED_VERSION ]] || warn "could not determine installed clideck version"

# --- Issue cert -------------------------------------------------------------
install -d -m 755 /etc/clideck
install -d -o clideck -g clideck -m 750 /etc/clideck/tls

info "requesting Tailscale certificate for $FQDN"
pushd /etc/clideck/tls >/dev/null
  tailscale cert "$FQDN" \
    || die "tailscale cert failed — enable HTTPS certificates in the Tailscale admin UI (DNS tab)"
  # tailscale writes <fqdn>.crt and <fqdn>.key
  mv -f "${FQDN}.crt" fullchain.pem
  mv -f "${FQDN}.key" privkey.pem
  chown clideck:clideck fullchain.pem privkey.pem
  chmod 640 fullchain.pem
  chmod 600 privkey.pem
popd >/dev/null

# --- Write env file (idempotent) -------------------------------------------
ENV_FILE=/etc/clideck/clideck.env
if [[ -f $ENV_FILE ]]; then
  info "$ENV_FILE already exists — leaving credentials in place (delete to reset)"
else
  read -rp "Choose an admin username [admin]: " USERNAME
  USERNAME=${USERNAME:-admin}
  read -rsp "Choose an admin password (blank → generated): " PASSWORD
  echo
  if [[ -z $PASSWORD ]]; then
    # base64url has no special chars that systemd's EnvironmentFile parser
    # mishandles. User-supplied passwords go through quoted form below.
    PASSWORD=$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')
    info "generated password: $PASSWORD"
    warn "save this password — it will not be shown again"
  fi

  # Quote every value: systemd's EnvironmentFile parser is NOT a shell.
  # An unquoted value containing `#`, `$`, or `;` is silently truncated /
  # interpolated. Double-quoted values are taken literally (incl. spaces
  # and special chars) per systemd.exec(5).
  info "writing $ENV_FILE"
  cat > "$ENV_FILE" <<EOF
CLIDECK_HOST="$TSIP"
CLIDECK_PORT="443"
CLIDECK_TLS_CERT_PATH="/etc/clideck/tls/fullchain.pem"
CLIDECK_TLS_KEY_PATH="/etc/clideck/tls/privkey.pem"
CLIDECK_ALLOWED_ORIGINS="https://$FQDN"
CLIDECK_TAILSCALE_FQDN="$FQDN"
CLIDECK_PUBLIC_MODE="1"
CLIDECK_USERNAME="$USERNAME"
CLIDECK_PASSWORD="$PASSWORD"
CLIDECK_COOKIE_SECURE="1"
EOF
  chown root:clideck "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

# --- setcap on node ---------------------------------------------------------
NODE_BIN=$(readlink -f "$(command -v node)")
info "granting cap_net_bind_service to $NODE_BIN"
setcap 'cap_net_bind_service=+ep' "$NODE_BIN"
case "$NODE_BIN" in
  /home/*|*/.nvm/*|*/.volta/*|*/.fnm/*)
    warn "node is at $NODE_BIN — looks like a per-user install (nvm/volta/fnm)"
    warn "any future node upgrade will silently lose this capability and"
    warn "clideck will fail to bind :443. Consider installing system node"
    warn "from your distro's package repos, or use the tailscale serve"
    warn "alternative documented in deploy/tailscale/serve.md."
    ;;
esac

# --- Install systemd units --------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prefer the units shipped alongside the script. If running via curl|bash,
# pin to the npm-installed clideck version rather than floating `main`.
fetch_unit() {
  local name="$1" dest_local="$SCRIPT_DIR/$1"
  if [[ -f $dest_local ]]; then
    cat "$dest_local"
    return
  fi
  if [[ -n $CLIDECK_INSTALLED_VERSION ]]; then
    local url="https://raw.githubusercontent.com/prakersh/clideck/v${CLIDECK_INSTALLED_VERSION}/deploy/tailscale/${name}"
    info "downloading $name pinned to v${CLIDECK_INSTALLED_VERSION}" >&2
    curl -fsSL "$url" || die "failed to fetch $name from $url"
  else
    warn "no installed version pin available; falling back to main"
    curl -fsSL "https://raw.githubusercontent.com/prakersh/clideck/main/deploy/tailscale/${name}"
  fi
}

fetch_unit clideck.service        > /etc/systemd/system/clideck.service
fetch_unit cert-renew.service     > /etc/systemd/system/clideck-cert-renew.service
fetch_unit cert-renew.timer       > /etc/systemd/system/clideck-cert-renew.timer
chmod 644 /etc/systemd/system/clideck.service \
          /etc/systemd/system/clideck-cert-renew.service \
          /etc/systemd/system/clideck-cert-renew.timer

systemctl daemon-reload
systemctl enable --now clideck
systemctl enable --now clideck-cert-renew.timer

sleep 2
if systemctl is-active --quiet clideck; then
  info "clideck is running"
else
  warn "clideck did not start cleanly — check: journalctl -u clideck -n 50"
fi

if systemctl is-enabled --quiet clideck-cert-renew.timer; then
  info "monthly cert renewal enabled (clideck-cert-renew.timer)"
fi

echo
info "open this on your phone (while connected to the tailnet):"
echo
echo "    https://$FQDN/"
echo
info "login: $USERNAME"
info "to rotate the cert manually, re-run this script (it is idempotent)"
info "note: cert renewal restarts clideck — active terminal sessions will drop"
