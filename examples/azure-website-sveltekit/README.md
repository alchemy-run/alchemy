# Azure Website: SvelteKit

A [SvelteKit](https://svelte.dev/docs/kit) site deployed with
`Azure.Website.SvelteKit`. No adapter setup in the project config, no
Docker image, and no App Service plan.

Alchemy creates a resource group, a storage account, a Flex Consumption
Functions app, and an Azure Front Door (Standard) profile. Front Door
sends `/_app/*` and the `static/` files to Blob Storage and every other
path to the Function, which runs kit's server.

- The home page is server-rendered on the Function and reads `GREETING` from `process.env` (an app setting).
- `/about` is prerendered at build time; the Function fetches its HTML file from Blob Storage.
- A Tailwind-styled Card component ships with the page.

```ts
const site = yield* Azure.Website.SvelteKit("SvelteKitSite", {
  location: "eastus",
  env: { GREETING: "Hello from SvelteKit on Azure!" },
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
endpoint takes 10-20 minutes to serve everywhere. Unchanged sources skip
the build entirely on subsequent deploys: the input files are
content-hashed (scoped by `memo.include`).

## Dev

```sh
bun run dev
```

`alchemy dev` runs kit's own Vite dev server (HMR included) and no Azure
resources are created.

## Destroy

```sh
bun run destroy
```

Deleting the Front Door profile takes 15-30 minutes.
