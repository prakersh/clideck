# Deploying clideck on a VPS behind Tailscale HTTPS

This directory contains everything needed to run clideck on a Linux VPS, reachable **only** through your Tailscale tailnet, over HTTPS, with no dependency on any third-party relay.

## Why this setup

- **No relay.** Your phone connects directly to the VPS over WireGuard (Tailscale). There is no intermediate server that could be compromised or push malicious JS into the browser.
- **Real TLS.** Tailscale provisions a publicly-valid Let's Encrypt certificate for your tailnet hostname (`host.<tailnet>.ts.net`), so the browser trusts it without warnings, and the PWA / service worker requirements are satisfied.
- **Everything in one place.** clideck serves its own PWA — there is no separate mobile web app to trust.

## Architecture

```
┌─────────────────┐    WireGuard    ┌──────────────────────┐
│   Phone (PWA)   │◀──tailnet──────▶│  VPS                 │
│   Tailscale app │                 │  ├─ tailscaled       │
└─────────────────┘                 │  └─ clideck (HTTPS)  │
                                    └──────────────────────┘
```

- The VPS binds clideck on a loopback-only port or the `tailscale0` interface.
- The public internet never sees the service — no port opened on the WAN.
- TLS terminates inside clideck using the cert Tailscale issues.

## Prerequisites

- A VPS running Linux (Debian / Ubuntu tested; others work).
- A Tailscale account and tailnet — free tier is fine.
- `tailscale` installed and `tailscale up` completed on the VPS.
- MagicDNS **enabled** in your tailnet (Admin → DNS → MagicDNS on).
- HTTPS certificates **enabled** (Admin → DNS → HTTPS certificates on — required once per tailnet).
- Node.js 18+ on the VPS.

## One-shot setup

On the VPS, as a normal user with `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/prakersh/clideck/main/deploy/tailscale/setup.sh | bash
```

Or, if you've cloned the repo:

```bash
sudo bash deploy/tailscale/setup.sh
```

The script:

1. Checks `tailscale status` and extracts your host's tailnet FQDN (e.g. `<host>.<tailnet>.ts.net`).
2. Creates a dedicated `clideck` system user with home in `/var/lib/clideck/`. The service runs as this user — *not* as root — so the systemd hardening directives (`ProtectSystem`, `NoNewPrivileges`, capability bounding) actually apply.
3. Runs `sudo tailscale cert <fqdn>` to issue / renew the Let's Encrypt cert into `/etc/clideck/tls/` (root-owned dir, group-readable by `clideck`).
4. Writes `/etc/clideck/clideck.env` with the production env vars **only on first run** — re-runs leave existing credentials in place. Delete the file to reset.
5. Installs `clideck` globally via `npm` (if not present), then pins the systemd unit fetch to that exact npm version when downloaded via `curl | bash`.
6. `setcap`s the resolved `node` binary so the unprivileged `clideck` user can bind `:443`. Warns when node is per-user (nvm/volta/fnm) since the cap is lost on the next node upgrade.
7. Installs the `clideck.service` systemd unit and the monthly `clideck-cert-renew.timer`, enables and starts both.
8. Prints the URL you should open on your phone.

Nothing is written outside `/etc/clideck/`, `/var/lib/clideck/`, and `/etc/systemd/system/clideck*.service{,.timer}`.

## Manual setup (if you don't want to run the script)

> Throughout this section, `<FQDN>` is your host's full tailnet hostname (e.g. `myvps.taila85232.ts.net`) — get it with `tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//'`.

### 0. Create a dedicated user

```bash
sudo useradd --system --create-home --home-dir /var/lib/clideck --shell /usr/sbin/nologin clideck
```

### 1. Issue a Tailscale certificate

```bash
cd /etc/clideck/tls   # mkdir -p if first run
sudo tailscale cert <FQDN>
sudo install -o clideck -g clideck -m 640 "<FQDN>.crt" fullchain.pem
sudo install -o clideck -g clideck -m 600 "<FQDN>.key" privkey.pem
```

Tailscale certs are 90 days. The bundled `cert-renew.timer` (installed as `clideck-cert-renew.timer`) re-runs `tailscale cert` monthly. Note that *Node loads TLS material once at startup* — there is no in-process reload. The renewal unit therefore restarts the clideck service after rotating the files. Active terminal sessions will drop during that restart; the monthly cadence keeps disruption rare.

### 2. Bind to the Tailscale interface

Get the VPS's tailnet IP:

```bash
tailscale ip -4
# e.g. 100.101.102.103
```

### 3. Configure clideck

Write `/etc/clideck/clideck.env` (mode `640`, owner `root:clideck`). Note: systemd's `EnvironmentFile` parser is **not** a shell — `#` starts a comment, `$` is not interpolated, and unquoted values that contain those characters get truncated. **Quote every value** to be safe:

```bash
# Bind only to the Tailscale interface — not 0.0.0.0
CLIDECK_HOST="<TSIP>"
CLIDECK_PORT="443"

# TLS
CLIDECK_TLS_CERT_PATH="/etc/clideck/tls/fullchain.pem"
CLIDECK_TLS_KEY_PATH="/etc/clideck/tls/privkey.pem"

# CSRF/origin allowlist (must match exactly what the browser sends)
CLIDECK_ALLOWED_ORIGINS="https://<FQDN>"

# Used by clideck-cert-renew.service to know which hostname to renew
CLIDECK_TAILSCALE_FQDN="<FQDN>"

# Public deployment mode — require explicit credentials, no local-loopback bootstrap
CLIDECK_PUBLIC_MODE="1"
CLIDECK_USERNAME="<choose a username>"
CLIDECK_PASSWORD="<choose a strong password>"
CLIDECK_COOKIE_SECURE="1"
```

Binding to `:443` requires either `setcap 'cap_net_bind_service=+ep' $(command -v node)` or running clideck behind a reverse proxy. For a direct bind, `setcap` is the smallest hop:

```bash
sudo setcap 'cap_net_bind_service=+ep' $(readlink -f "$(command -v node)")
```

### 4. systemd unit

Copy [clideck.service](./clideck.service) to `/etc/systemd/system/clideck.service`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now clideck
sudo systemctl status clideck
```

### 5. Open on your phone

```
https://<FQDN>/
```

On first visit, log in with the credentials you set. On iOS/Android, the browser's "Add to Home Screen" offer installs the PWA. After that, clideck launches like a native app — and because the phone is on Tailscale, it works from anywhere.

## Firewall

The **public internet should not see port 443 on your VPS**. Confirm:

```bash
sudo ss -tlnp | grep :443
# should show 100.101.102.103:443  — NOT 0.0.0.0:443 or :::443
```

If you use UFW / iptables, you do not need to open 443 publicly — Tailscale handles ingress through the WireGuard tunnel.

```bash
# Example UFW rules for a Tailscale-only setup
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0
sudo ufw allow ssh          # optional, for management
sudo ufw enable
```

## Verification checklist

From your phone (on Tailscale):
- [ ] `https://<FQDN>/` loads in a browser with no cert warning.
- [ ] Log in succeeds. Dashboard renders.
- [ ] Create a shell session — keyboard input works, output streams.
- [ ] Reload page — session is restored.
- [ ] "Add to Home Screen" is offered. After install, the app opens without browser chrome.

From outside your tailnet (disconnect Tailscale on the phone):
- [ ] `https://<FQDN>/` **fails to resolve / connect** — this is correct.
- [ ] There is no exposed public port on the VPS.

## Troubleshooting

**`tailscale cert` fails with "HTTPS certificates are not enabled"**
: Go to the Tailscale admin console → DNS → enable HTTPS certificates (one-time).

**PWA won't install / service worker refuses to register**
: Browsers require HTTPS with a valid cert. Self-signed certs won't work. Use `tailscale cert` (Let's Encrypt) or a Caddy/Cloudflare-issued cert.

**WebSocket closes immediately on the phone**
: Check `CLIDECK_ALLOWED_ORIGINS` matches exactly what your browser sends (including `https://` prefix and no trailing slash).

**`EACCES: permission denied, 0.0.0.0:443`**
: Either use `setcap 'cap_net_bind_service=+ep' $(readlink -f "$(command -v node)")` to let unprivileged Node bind low ports, or put the clideck process behind `authbind` / a reverse proxy.

## Alternative: Tailscale Serve (recommended if you don't want to handle TLS inside Node)

Instead of terminating TLS inside clideck, you can let Tailscale do it:

```bash
# Run clideck on loopback, HTTP
CLIDECK_HOST=127.0.0.1 CLIDECK_PORT=4000 clideck &

# Tell Tailscale to serve it as HTTPS on 443
sudo tailscale serve --bg --https=443 http://127.0.0.1:4000
```

Tailscale handles the cert lifecycle and proxies WebSockets transparently. This is the simplest setup and the one recommended for most users.

See [serve.md](./serve.md) for the full walk-through and systemd unit for this variant.
