---
order: 2
---

# Cloudflare TanStack Start

This guide walks through how to deploy a TanStack Start application to Cloudflare Workers with Alchemy.

## Create the TanStack Start Project

```sh
bunx gitpick TanStack/router/tree/main/examples/react/start-basic start-basic
cd start-basic
bun i
```

> [!NOTE]
> See TanStack's [Quick Start](https://tanstack.com/start/latest/docs/framework/react/quick-start) guide.

## Create `alchemy.run.ts`

Create the `alchemy.run.ts` script in the root of the TanStack Start project.

This stack will build the app, bundle the assets and deploy a Worker with the Assets bound to `ASSETS` which is expected by Nitro (the build system backing TanStack).

```ts
import "alchemy/cloudflare";

import alchemy from "alchemy";
import { TanStackStart } from "alchemy/cloudflare";

const app = await alchemy("tanstack-app", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up"
});

const website = await TanStackStart("tanstack-website", {
  command: "bun run build"
});

console.log({
  url: website.url,
});

await app.finalize();
```

## Configure `app.config.ts` for Cloudflare

TanStack's `app.config.ts` needs to be configured to produce a server bundle compatible with Cloduflare:

```ts
import { defineConfig } from "@tanstack/react-start/config";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  tsr: {
    appDirectory: "src",
  },
  server: {
    // muse use the cloudflare-module preset for Workers with Assets
    preset: "cloudflare-module",
    experimental: {
      // server functions break without this
      asyncContext: true,
    },
    unenv: {
      // server functions break without this
      external: ["node:async_hooks"],
    },
  },
  vite: {
    plugins: [
      tsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
    ],
  },
});
```

## Build & Deploy

Now just run the `alchemy.run` script to deploy the app to Cloudflare:

```sh
bun ./alchemy.run
```

## Tear Down

If you are just experimenting and want to delete the site, run with `--destroy`:

```sh
bun ./alchemy.run --destroy
```
