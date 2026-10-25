# Azure Website: Vite

A Tailwind React SPA deployed with `Azure.Website.Vite`. Alchemy creates a
resource group, a storage account, and an Azure Front Door (Standard)
profile, then uploads the `vite build` output to the account's `$web`
container. Front Door serves the site, caches hashed assets, and answers
client-side routes with the app shell. No Docker image and no server are
involved.

- `alchemy deploy` builds the SPA and serves it at `https://{endpoint}.z01.azurefd.net`.
  A new Front Door endpoint takes 10-20 minutes to serve everywhere.
- A redeploy uploads only changed files and purges their paths from Front Door.
- `alchemy dev` is Vite's own server (HMR included); no Azure resources are created.

Requires an Azure profile (`alchemy login azure`). Front Door bills a
monthly base fee per profile; run `bun run destroy` when you are done.

```sh
bun run deploy
bun run destroy
```
