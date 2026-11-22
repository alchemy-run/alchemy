# Azure Website: Static site

A plain HTML and TypeScript site deployed with `Azure.Website.StaticSite`.
Alchemy runs the build command (`vite build` here; any generator works),
creates a resource group, a storage account, and an Azure Front Door
(Standard) profile, then uploads `dist/` to the account's `$web` container.
Front Door serves the site and answers unknown paths with `404.html` and a
`404` status. No Docker image and no server are involved.

- `alchemy deploy` builds the site and serves it at `https://{endpoint}.z01.azurefd.net`.
  A new Front Door endpoint takes 10-20 minutes to serve everywhere.
- A redeploy uploads only changed files and purges their paths from Front Door.
- `alchemy dev` runs `dev.command` (Vite's dev server) in place of the build;
  no Azure resources are created.

Requires an Azure profile (`alchemy login azure`). Front Door bills a
monthly base fee per profile; run `bun run destroy` when you are done.

```sh
bun run deploy
bun run dev
bun run destroy
```

## Verify

```sh
ALCHEMY_PROFILE=<profile> bun test test/integ.test.ts   # deploy, fetch through Front Door, destroy
bun test test/dev.test.ts                               # alchemy dev end to end
```

Open the deployed URL. Click **count: 0**; it becomes **count: 1**. Click
**Load greeting** and the greeting from `/example.json` appears under the
button.
