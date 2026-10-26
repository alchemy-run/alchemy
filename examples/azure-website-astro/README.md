# Azure Website: Astro

Deploys an [Astro](https://astro.build) site to Azure with
`Azure.Website.Astro` — no adapter setup in the project config, no Docker,
and no App Service plan.

Alchemy creates a resource group, a storage account, a Flex Consumption
Azure Function, and an Azure Front Door (Standard) profile. Front Door
serves the client directory (`/_astro/*`, `public/` files, prerendered
pages) from the account's `$web` container and sends every other path to
the Function, which renders the page on demand.

- The home page is server-rendered on the Function and reads `GREETING` from `process.env`.
- `/about/` is prerendered at build time and served from Blob Storage.
- A Tailwind-styled Card component ships with the page.

```ts
const site = yield* Azure.Website.Astro("Astro", {
  location: "eastus",
  env: { GREETING: "Hello from Astro on Azure!" },
});
```

The integration package must be installed in the project (it is loaded
dynamically at deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

## Deploy

```sh
bun run deploy
```

The site serves at `https://{endpoint}.z01.azurefd.net`. A new Front Door
endpoint takes 10-20 minutes to serve everywhere. Unchanged sources skip
the build on later deploys (the input files are content-hashed, scoped by
`memo.include`), and a redeploy purges the paths of changed files from
Front Door.

## Dev

```sh
bun run dev
```

`alchemy dev` runs Astro's own dev server (HMR included) and no Azure
resources are created.

## Destroy

Requires an Azure profile (`alchemy login azure`). Front Door bills a
monthly base fee per profile; destroy the stack when you are done. The
profile delete takes 15-30 minutes.

```sh
bun run destroy
```
