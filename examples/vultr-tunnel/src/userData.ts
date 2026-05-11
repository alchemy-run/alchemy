import * as Output from "alchemy/Output";

/**
 * cloud-init bash script run on first boot of the Vultr instance.
 *
 * Returns an `Output<string>` because the tunnel token only resolves
 * after the `Cloudflare.Tunnel` resource is reconciled. `Output.interpolate`
 * weaves it into the script.
 */
export const buildUserData = (params: {
  hostname: string;
  tunnelToken: Output.Output<string>;
}) =>
  Output.interpolate`#!/bin/bash
set -euxo pipefail

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  debian-keyring debian-archive-keyring apt-transport-https curl gnupg ca-certificates

# --- caddy -----------------------------------------------------------
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y caddy

cat > /etc/caddy/Caddyfile <<'CADDY'
:8080 {
  respond "Hello from ${params.hostname} via Vultr + Cloudflare Tunnel!"
}
CADDY
systemctl restart caddy
systemctl enable caddy

# --- cloudflared -----------------------------------------------------
ARCH=$(dpkg --print-architecture)
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-\${ARCH}.deb" \
  -o /tmp/cloudflared.deb
dpkg -i /tmp/cloudflared.deb

cloudflared service install ${params.tunnelToken}
systemctl enable cloudflared
systemctl start cloudflared
`;
