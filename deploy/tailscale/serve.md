# Alternative: `tailscale serve` (simplest setup)

If you don't want to deal with cert files or binding :443 yourself, let Tailscale handle it. `tailscale serve` terminates TLS and proxies traffic to a local HTTP port on the VPS — including WebSockets.

## Setup

```bash
# 1. Install clideck
npm install -g clideck

# 2. Run clideck on loopback, HTTP only
cat > /etc/clideck/clideck.env <<'EOF'
CLIDECK_HOST=127.0.0.1
CLIDECK_PORT=4000
CLIDECK_ALLOWED_ORIGINS=https://<FQDN>
CLIDECK_PUBLIC_MODE=1
CLIDECK_USERNAME=admin
CLIDECK_PASSWORD=<strong-password>
CLIDECK_COOKIE_SECURE=1
EOF

# 3. systemd unit (simpler than the direct-TLS variant — no cert paths, no caps)
cat > /etc/systemd/system/clideck.service <<'EOF'
[Unit]
Description=clideck
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/clideck/clideck.env
ExecStart=/usr/bin/env clideck
KillSignal=SIGTERM
TimeoutStopSec=15
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now clideck

# 4. Tell Tailscale to serve clideck as HTTPS on :443
sudo tailscale serve --bg --https=443 http://127.0.0.1:4000

# 5. Confirm
tailscale serve status
```

Output should look like:

```
https://<FQDN> (tailnet only)
|-- / proxy http://127.0.0.1:4000
```

## Why this is the recommended path for most users

- **No cert handling.** Tailscale issues, stores, and auto-renews the cert.
- **No `setcap`.** The service only listens on 127.0.0.1:4000 — no privileged port bind.
- **WebSocket upgrade just works.** `tailscale serve` proxies the HTTP/1.1 upgrade transparently.
- **Clean rollback.** `tailscale serve --https=443 off` tears the whole front-end down without touching clideck.

## Caveats

- `tailscale serve` is only reachable from inside your tailnet. That is the whole point — but remember to enable Tailscale on your phone before trying to open the URL.
- If you also want the URL reachable from devices outside your tailnet (e.g. a teammate without Tailscale), you'd use `tailscale funnel` instead of `serve`. That exposes the port to the public internet via Tailscale's edge. Only do this if you understand the implications — the login page becomes reachable by anyone on the internet (protected by clideck's auth, not by the tailnet boundary).

## Rotating credentials

Edit `/etc/clideck/clideck.env`, then:

```bash
sudo systemctl restart clideck
```
