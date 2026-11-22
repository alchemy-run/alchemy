# Azure Website: SolidStart

A [SolidStart](https://start.solidjs.com) site deployed with
`Azure.Website.SolidStart`. No adapter setup in the project config, no
Docker image, and no App Service plan.

Alchemy creates a resource group, a storage account, a Flex Consumption
Functions app, and an Azure Front Door (Standard) profile. Front Door
sends `/_build/*` and the `public/` files to Blob Storage and every other
path to the Function, which runs SolidStart's nitro server.

- `src/routes/index.tsx` is server-rendered on the Function and reads `GREETING` from `process.env` (an app setting).
- `vite.config.ts` holds only `solidStart()` and the Tailwind plugin — no `nitroV2Plugin()`; the deploy target owns the nitro plugin instance.

```ts
const site = yield* Azure.Website.SolidStart("Website", {
  location: "eastus",
  env: { GREETING: "Hello from SolidStart on Azure!" },
});
```

The integration package must be installed in the project (it is loaded
dynamically at deploy time), alongside `@solidjs/vite-plugin-nitro-2`:

```sh
bun add -d @alchemy.run/frontend-frameworks
bun add @solidjs/vite-plugin-nitro-2
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

`alchemy dev` runs SolidStart's own dev server (HMR included) and no
Azure resources are created. SolidStart 2's dev server (via `srvx/node`)
misrenders under Bun, so run `alchemy dev` with Node for this example.

## Destroy

```sh
bun run destroy
```

Deleting the Front Door profile takes 15-30 minutes.
