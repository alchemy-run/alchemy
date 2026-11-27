# @alchemy.run/cloudflare-runtime

Cloudflare Workers runtime and build integrations for Alchemy.

- `@alchemy.run/cloudflare-runtime/core` — local Workers runtime
- `@alchemy.run/cloudflare-runtime/rolldown` — Rolldown plugin
- `@alchemy.run/cloudflare-runtime/vite` — Vite plugin

## Upstream references

- Cloudflare Workers SDK: [`110c16279a91927427396b0f3760e27d59a8079a`](https://github.com/cloudflare/workers-sdk/tree/110c16279a91927427396b0f3760e27d59a8079a)

The runtime was last compared with miniflare, `workers-shared` and
`workflows-shared` at this commit. Vite plugin parity is tracked separately in
[`src/vite/PARITY.md`](./src/vite/PARITY.md).

## Keeping up with upstream

**workerd is pinned to an exact version** in the workspace catalog, as
miniflare pins it. workerd refuses a compatibility date later than its own
build, so a version range could install an older workerd than the default date
below was chosen for, and every Worker without a date of its own would fail to
start.

**`DEFAULT_COMPATIBILITY_DATE` follows the pinned workerd's build date**, as
miniflare's `DEFAULT_COMPAT_DATE` does. Raise them together.
`withDefaultFlags` still adds `new_module_registry` for Workers that set a date
of their own before 2026-11-17. From that date workerd turns it on by default
and refuses the flag, as it refuses any flag that is already a default.

**Upstream changes left out on purpose:**

| Upstream change | Why it isn't ported |
| --- | --- |
| The local Artifacts simulator, and starting local Workflows from Artifacts events (`triggers.events`) | Alchemy's Artifacts binding always uses the deployed service; there is no local simulator for the events to come from. |
| Rotating the container session when a Worker's container configuration changes | Containers are adopted by name, as before this sync. Rotating sessions would mean reworking `Docker.ts` for a case that isn't a regression. |
| Removing containers left by a process that was killed (`SIGKILL`, out of memory) | Upstream's exit-hook cleanup can't run then either. Graceful exits are covered by the scope finalizer. Leftovers carry the `alchemy.runtime` label, so `docker ps -aq --filter label=alchemy.runtime` finds them. |
| Strict `.assetsignore` decoding when deploying | That change is in Wrangler's deploy path. Alchemy's local asset handling decodes strictly; deploying lives in `packages/cloudflare`. |
