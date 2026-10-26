# Azure Website: React Router

A [React Router](https://reactrouter.com) v7 (framework mode) app deployed
with `Azure.Website.ReactRouter`. Alchemy creates a resource group, a
storage account, a Flex Consumption Function, and an Azure Front Door
(Standard) profile. The Function runs the server build (loaders, actions,
page renders); the client assets go to the account's `$web` container.
Front Door sends `/assets/*` and the public files to Blob Storage and every
other path to the Function. No Docker image, no App Service plan, and no
adapter in the project config.

- `app/routes/home.tsx` is server-rendered on the Function and reads the `GREETING` app setting from `process.env`.
- `app/components/Card.tsx` is a React component styled with Tailwind utilities.
- `alchemy deploy` serves the site at `https://{endpoint}.z01.azurefd.net`.
  A new Front Door endpoint takes 10-20 minutes to serve everywhere.
- `alchemy dev` runs React Router's own dev server (HMR included); no Azure resources are created.

Requires an Azure profile (`alchemy login azure`). Front Door bills a
monthly base fee per profile; run `bun run destroy` when you are done.

```sh
bun run deploy
bun run destroy
```
