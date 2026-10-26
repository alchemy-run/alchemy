# Azure Website: Foldkit

Deploys a [Foldkit](https://foldkit.dev) app to Azure with
`Azure.Website.Foldkit` — no adapter setup in the project config, no
Docker, and no server.

This example is a client-only Foldkit app, so the deploy is assets-only.
Alchemy creates a resource group, a storage account, and an Azure Front
Door (Standard) profile, then uploads the `vite build` output to the
account's `$web` container. Front Door serves the site, caches the hashed
assets, and answers client-side routes such as `/counter/42` with the app
shell and a `200` status.

- `src/main.ts` holds the Elm-architecture model/update/view.
- `src/components/Card.ts` is a view function styled with Tailwind utilities.

```ts
const site = yield* Azure.Website.Foldkit("Foldkit", { location: "eastus" });
```

Set `output: "server"` (with `ssr.build` in `vite.config.ts`) to render
pages on a Flex Consumption Azure Function behind the same Front Door.

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
endpoint takes 10-20 minutes to serve everywhere. A redeploy uploads only
changed files and purges their paths from Front Door.

## Dev

```sh
bun run dev
```

`alchemy dev` runs Foldkit's own Vite dev server (HMR included) and no
Azure resources are created.

## Destroy

Requires an Azure profile (`alchemy login azure`). Front Door bills a
monthly base fee per profile; destroy the stack when you are done. The
profile delete takes 15-30 minutes.

```sh
bun run destroy
```
