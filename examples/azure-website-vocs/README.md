# Azure Website: Vocs

Deploys a [Vocs](https://vocs.dev) documentation site to Azure with
`Azure.Website.Vocs` — no adapter setup in the project config.

Alchemy creates a resource group, a Flex Consumption Function that runs the
Vocs server, a storage account whose `$web` container holds the client
assets, and an Azure Front Door (Standard) profile. Front Door sends
`/assets/*`, `public/` files and `llms.txt` to Blob Storage and the pages to
the Function. No App Service plan, no containers.

```ts
const site = yield* Azure.Website.Vocs("VocsDocs", { location: "eastus" });
```

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

Requires an Azure profile (`alchemy login azure`). Front Door bills a
monthly base fee per profile; run `bun run destroy` when you are done.

## Deploy

```sh
bun run deploy
```

The site serves at `https://{endpoint}.z01.azurefd.net`. A new Front Door
endpoint takes 10-20 minutes to serve everywhere. Unchanged sources skip the
build entirely on later deploys (the input files in `memo.include` are
content-hashed).

## Dev

```sh
bun run dev
```

`alchemy dev` runs Vocs' own dev server (HMR included); no Azure resources
are created.

## Destroy

```sh
bun run destroy
```

Deleting the Front Door profile takes 15-30 minutes.
