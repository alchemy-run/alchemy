# Azure Website: Waku

Deploys a [Waku](https://waku.gg) site to Azure with `Azure.Website.Waku` —
no adapter setup in the project config.

Alchemy creates a resource group, a Flex Consumption Function that runs the
Waku server, a storage account whose `$web` container holds the client
assets, and an Azure Front Door (Standard) profile. Front Door sends
`/assets/*` and the files from `public/` to Blob Storage and every other path
to the Function. No App Service plan, no containers.

- The home page is rendered by the Function on every request and reads
  `GREETING` with `getEnv` (the Function's app settings).
- `/about` is prerendered at build time.
- A Tailwind-styled Card component ships with the page.

```ts
const site = yield* Azure.Website.Waku("WakuSite", {
  location: "eastus",
  env: { GREETING: "Hello from Waku on Azure!" },
});
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

`alchemy dev` runs Waku's own dev server (HMR included); no Azure resources
are created.

## Destroy

```sh
bun run destroy
```

Deleting the Front Door profile takes 15-30 minutes.
