# Azure Website: Nuxt

A Tailwind-styled [Nuxt](https://nuxt.com) app deployed with
`Azure.Website.Nuxt`. Alchemy creates a resource group, a storage account,
a Flex Consumption Function, and an Azure Front Door (Standard) profile. No
Docker image and no App Service plan.

- Front Door sends `/_nuxt/*`, the `public/` files and the prerendered
  `/about/` page to the storage account's static website, and every other
  path to the Function.
- The Function runs nitro's server bundle. The home page and
  `server/api/hello.ts` read `GREETING` from the Function's app settings.
- `alchemy dev` is Nuxt's own dev server (HMR included); no Azure resources
  are created.

```ts
const site = yield* Azure.Website.Nuxt("Web", {
  location: "eastus",
  env: { GREETING: "Hello from Nuxt on Azure!" },
});
```

The integration package must be installed in the project (it is loaded at
deploy time):

```sh
bun add -d @alchemy.run/frontend-frameworks
```

Requires an Azure profile (`alchemy login azure`). A new Front Door endpoint
takes 10-20 minutes to serve everywhere, and Front Door bills a monthly base
fee per profile: run `bun run destroy` when you are done.

```sh
bun run deploy
bun run dev
bun run destroy
```
