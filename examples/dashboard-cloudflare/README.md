# dashboard-cloudflare

Deploys the alchemy dashboard as a **hosted state viewer** on Cloudflare: the
same `@alchemy.run/dashboard` SPA the CLI serves for `alchemy deploy --ui`,
running as a Worker that reads a deployed alchemy state store — no CLI
process required.

Everything is derived at deploy time: the Worker gets the state store's
endpoint and token that `Cloudflare.state()` caches for your profile, a
service binding to the `alchemy-state-store` Worker (Cloudflare blocks
same-zone worker-to-worker `fetch`), and the SPA from the installed
`@alchemy.run/dashboard` package.

```sh
bun run deploy
```

The dashboard exposes everything the state store holds, so `access` is a
required choice: Cloudflare Access policies (Alchemy creates the Access
application) or `"public"`.
