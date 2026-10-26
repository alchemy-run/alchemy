# Azure Website: Next.js

A Tailwind-styled [Next.js](https://nextjs.org) app deployed with
`Azure.Website.Nextjs`. Alchemy creates a resource group, a storage
account, a Flex Consumption Function, and an Azure Front Door (Standard)
profile. No Docker image, no App Service plan, and no OpenNext.

- Front Door sends `/_next/static/*` and the `public/` files to the storage
  account's static website, and every other path to the Function.
- The Function runs Next's standalone server. `app/page.jsx` renders on
  every request and reads `GREETING` from the Function's app settings.
- `app/api/hello/route.ts` is an App Router route handler.
- `alchemy dev` is `next dev` (HMR included); no Azure resources are created.

```ts
const site = yield* Azure.Website.Nextjs("Web", {
  location: "eastus",
  env: { GREETING: "Hello from Next.js on Azure!" },
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
