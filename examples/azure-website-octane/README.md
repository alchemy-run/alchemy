# Azure Website: Octane

An [Octane](https://octanejs.dev) app deployed with `Azure.Website.Octane`.
Alchemy creates a resource group, a storage account, a Flex Consumption
Function, and an Azure Front Door (Standard) profile. The Function runs
Octane's fetch handler (SSR pages and the `/api/hello` server route); the
client assets go to the account's `$web` container. Front Door sends
`/assets/*` and the public files to Blob Storage and every other path to the
Function. No Docker image and no App Service plan are involved.

- `alchemy deploy` builds the app and serves it at `https://{endpoint}.z01.azurefd.net`.
  A new Front Door endpoint takes 10-20 minutes to serve everywhere.
- `/api/hello` reads the `GREETING` app setting from `process.env`.
- `alchemy dev` is Octane's own Vite dev server (HMR included); no Azure resources are created.

`octane.config.ts` has no adapter: `Azure.Website.Octane` wraps Octane's
native Node output in an Azure Functions handler.

Requires an Azure profile (`alchemy login azure`). Front Door bills a
monthly base fee per profile; run `bun run destroy` when you are done.

```sh
bun run deploy
bun run destroy
```
