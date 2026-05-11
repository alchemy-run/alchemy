# vultr-tunnel

Minimal Alchemy stack that:

1. Provisions a Vultr shared-CPU VM (`vc2-1c-1gb`, Ubuntu 22.04) in EWR.
2. Creates a Cloudflare Tunnel + proxied CNAME on `ktarz.com`.
3. cloud-init installs Caddy (`:8080`) and `cloudflared` on the VM, so `https://vultr-demo.ktarz.com` flows Cloudflare → tunnel → Caddy → "Hello from … via Vultr + Cloudflare Tunnel!".

Lives inside the alchemy workspace (`examples/vultr-tunnel/`) so the local `alchemy/Vultr` provider at `packages/alchemy/src/Vultr/` and the workspace `catalog:` deps resolve via `bun install` at the repo root.

## Prerequisites

1. **Add `ktarz.com` to the Cloudflare account** (`c468c0b4eb926594d104367f16c9eff1`). Until the zone is active, deploy will fail at the DNS step with `zone not found`.
   - Dashboard → Add a site → Free plan → repoint your registrar's nameservers.
2. **API token scopes.** `CLOUDFLARE_API_TOKEN` needs at minimum:
   - Account: `Cloudflare Tunnel:Edit`
   - Zone (ktarz.com): `DNS:Edit`

Env vars are read from `.env`, symlinked here from `~/ktarz/.env`.

## Run

```sh
# one-time at the repo root:
bun install

# then in this folder:
cd examples/vultr-tunnel
bun run plan      # CI=true alchemy plan        ← dry-run, no resources created
bun run deploy    # CI=true alchemy deploy
bun run destroy   # CI=true alchemy destroy
```

`CI=true` tells the alchemy Cloudflare auth provider to read credentials directly from `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` instead of prompting interactively. Vultr always reads from `VULTR_API_KEY`.

## Verifying after deploy

```sh
curl https://vultr-demo.ktarz.com
# → Hello from vultr-demo.ktarz.com via Vultr + Cloudflare Tunnel!
```

cloud-init runs once on first boot — allow ~90–120s after the VM reaches `active` for Caddy and cloudflared to come up. To watch:

```sh
ssh root@<mainIp>   # root password is in the alchemy state file or the Vultr console
journalctl -u cloudflared -f
journalctl -u caddy -f
```

## Layout

```
.
├── .env                 → ~/ktarz/.env (symlink)
├── alchemy.run.ts       stack entrypoint
├── package.json
├── tsconfig.json
└── src/
    ├── DnsRecord.ts     local Cloudflare DNS CNAME resource (alchemy v2 has no DnsRecord yet)
    └── userData.ts      cloud-init bash script (Caddy + cloudflared)
```
