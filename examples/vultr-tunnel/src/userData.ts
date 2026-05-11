import * as Output from "alchemy/Output";

/**
 * cloud-init bash script run on first boot of the Vultr VM.
 *
 * Installs Bun, drops a small HTTP server at `/opt/app/index.ts` that
 * queries the Vultr Managed Postgres `messages` table, runs it under
 * systemd with `DATABASE_URL` in the environment, then installs
 * cloudflared bound to the named tunnel token. The Cloudflare Tunnel's
 * ingress points `vultr-demo.ktarz.com` → `http://localhost:8080`.
 *
 * Both `tunnelToken` and `databaseUrl` arrive as `Output<string>`
 * because they come from resources reconciled earlier in the stack —
 * `Output.interpolate` weaves the resolved values into the script.
 */
export const buildUserData = (params: {
  hostname: string;
  tunnelToken: Output.Output<string>;
  databaseUrl: Output.Output<string>;
}) =>
  Output.interpolate`#!/bin/bash
set -euxo pipefail

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl ca-certificates unzip

# --- bun -------------------------------------------------------------
# install for root so the systemd unit (User=root) can invoke it.
# The installer reads $HOME, which cloud-init does NOT set — without
# this export, \`set -u\` kills the script at "HOME: unbound variable"
# and the rest (app + cloudflared) never runs.
export HOME=/root
export BUN_INSTALL=/root/.bun
curl -fsSL https://bun.sh/install | bash
ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# --- app source ------------------------------------------------------
mkdir -p /opt/app
cat > /opt/app/index.ts <<'APP'
import { sql } from "bun";

const PORT = 8080;

type Row = { id: number; body: string; created_at: Date };

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/") {
        const rows = (await sql\`SELECT id, body, created_at FROM messages ORDER BY id\`) as Row[];
        return Response.json({
          host: "${params.hostname}",
          count: rows.length,
          messages: rows,
        }, { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/health") {
        const [{ now }] = (await sql\`SELECT NOW() as now\`) as Array<{ now: Date }>;
        return Response.json({ ok: true, db_now: now });
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 });
    }
  },
});

console.log(\`listening on :\${PORT}\`);
APP

# --- systemd unit ----------------------------------------------------
cat > /etc/systemd/system/app.service <<APPSVC
[Unit]
Description=Bun app for vultr-demo
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/app
Environment=DATABASE_URL=${params.databaseUrl}
ExecStart=/usr/local/bin/bun run /opt/app/index.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
APPSVC

systemctl daemon-reload
systemctl enable app
systemctl start app

# --- cloudflared -----------------------------------------------------
ARCH=$(dpkg --print-architecture)
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-\${ARCH}.deb" \
  -o /tmp/cloudflared.deb
dpkg -i /tmp/cloudflared.deb

cloudflared service install ${params.tunnelToken}
systemctl enable cloudflared
systemctl start cloudflared
`;
