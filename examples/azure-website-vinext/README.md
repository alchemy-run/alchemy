# Azure Website: vinext

Deploys a [vinext](https://vinext.dev) App Router application to Azure with
`Azure.Website.Vinext` — no Docker image, no App Service plan.

Alchemy creates a resource group, a storage account, a Flex Consumption
Function, and an Azure Front Door (Standard) profile:

- vinext's App Router fetch handler runs on the Function (scale to zero), with React bundled in.
- The client build (`dist/client`) goes to the storage account's `$web` container.
- Front Door sends `/_next/static/*` and the public files to Blob Storage and every other path to the Function.

```ts
const site = yield* Azure.Website.Vinext("Web", {
  location: "eastus",
  env: { GREETING: "Hello from vinext on a Function!" },
});
```

The example includes client hydration, Home/ISR navigation, an
environment-aware `/api/hello?name=Alchemy` route handler, ISR, and public
assets. The data cache is the Function's in-process memory, so each
instance keeps its own. Set `env.REDIS_URL` for a shared Redis store;
Alchemy injects the cache adapter automatically. Keep ordinary `vinext()`
configuration in Vite; configure deployment on `Azure.Website.Vinext`.

The integration package must be installed in the project (it is loaded at
build time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Run locally

```sh
bun run dev
```

`alchemy dev` runs native `vinext dev` with hot reload and creates no Azure
resources. Apply `Alchemy.remote()` to deploy live during development.

## Deploy

Requires an Azure profile (`alchemy login azure`).

```sh
bun run deploy
```

The site serves at `https://{endpoint}.z01.azurefd.net`. A new Front Door
endpoint takes 10-20 minutes to serve everywhere.

## Test and clean up

Front Door bills a monthly base fee per profile. Its delete takes 15-30
minutes.

```sh
bun test test/dev.test.ts
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
bun run destroy
```
