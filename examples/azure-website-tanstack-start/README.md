# Azure Website: TanStack Start

Deploys a [TanStack Start](https://tanstack.com/start) site to Azure with
`Azure.Website.TanStackStart` — no adapter setup in the project config, no
Docker image, no App Service plan.

Alchemy creates a resource group, a storage account, a Flex Consumption
Function, and an Azure Front Door (Standard) profile:

- Server-side rendering and server functions run on the Function (scale to zero).
- The `vite build` client output goes to the storage account's `$web` container.
- Front Door sends `/assets/*` and the public files to Blob Storage and every other path to the Function.

`src/routes/index.tsx` reads `GREETING` from `process.env` through a server
function. On Azure it is an app setting of the Function:

```ts
const site = yield* Azure.Website.TanStackStart("Web", {
  location: "eastus",
  env: { GREETING: "Hello from TanStack Start on Azure!" },
});
```

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

Requires an Azure profile (`alchemy login azure`).

```sh
bun run deploy
```

The site serves at `https://{endpoint}.z01.azurefd.net`. A new Front Door
endpoint takes 10-20 minutes to serve everywhere. Unchanged sources skip the
build entirely on later deploys: the input files are content-hashed (scoped
by `memo.include`). A redeploy uploads only changed assets and purges their
paths from Front Door.

## Dev

```sh
bun run dev
```

`alchemy dev` runs TanStack Start's own Vite dev server (HMR included); no
Azure resources are created.

## Destroy

Front Door bills a monthly base fee per profile. Its delete takes 15-30
minutes.

```sh
bun run destroy
```
