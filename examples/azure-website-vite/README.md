# Azure Website: Vite

A Tailwind React SPA deployed with `Azure.Website.Vite` to the static
website endpoint of an Azure Storage account. Alchemy creates a resource
group and a storage account, then uploads the `vite build` output to the
account's `$web` container. No Docker image and no server are involved.

- `alchemy deploy` builds the SPA and serves it at `https://{account}.z13.web.core.windows.net`.
- `alchemy dev` is Vite's own server (HMR included).

Requires an Azure profile (`alchemy login azure`).

```sh
bun run deploy
bun run destroy
```
