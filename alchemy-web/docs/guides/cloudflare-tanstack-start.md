---
order: 2
title: TanstackStart
description: Guide to deploying TanStack Start applications to Cloudflare Workers using Alchemy. Learn configuration for Cloudflare and local development setup.
---

# TanStack Start

This guide walks through how to deploy a TanStack Start application to Cloudflare Workers with Alchemy.

## Create a new TanStack Start Project

Start by creating a TanStack Start project:

```sh
bunx gitpick TanStack/router/tree/main/examples/react/start-basic start-basic
cd start-basic
bun install
```

> [!NOTE]
> See TanStack's [Quick Start](https://tanstack.com/start/latest/docs/framework/react/quick-start) guide for more details on TanStack Start applications.

## Install Alchemy and Cloudflare

Install the required dependencies:

```sh
bun add alchemy cloudflare
```

## Create `alchemy.run.ts`

Create an `alchemy.run.ts` file in the root of your project:

```ts
// ./alchemy.run.ts
import "alchemy/cloudflare";
import alchemy from "alchemy";
import { TanStackStart } from "alchemy/cloudflare";

const app = await alchemy("tanstack-app", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: process.argv.includes("--verbose") ? false : true,
});

// (resources go here)

await app.finalize(); // must be at end
```

## Add the TanStackStart Resource

Add the TanStackStart resource to your `alchemy.run.ts` file just before the `finalize()` call:

```ts
const website = await TanStackStart("tanstack-website", {
  command: "bun run build"
});

console.log({
  url: website.url,
});
```

## Configure TanStack for Cloudflare

TanStack Start needs configuration to work properly with Cloudflare Workers. Update your `app.config.ts` file:

```ts
// app.config.ts
import { defineConfig } from "@tanstack/react-start/config";
import tsConfigPaths from "vite-tsconfig-paths";
import { cloudflareWorkersDevEnvironmentShim } from "alchemy/cloudflare";

const external = ["node:async_hooks", "cloudflare:workers"];

export default defineConfig({
  tsr: {
    appDirectory: "src",
  },
  server: {
    preset: "cloudflare-module",
    experimental: {
      asyncContext: true,
    },
    unenv: {
      external,
    },
  },
  vite: {
    plugins: [
      // Provides a polyfill for Cloudflare Workers env during development
      cloudflareWorkersDevEnvironmentShim(),
      // Resolves paths based on tsconfig
      tsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
    ],
    build: {
      rollupOptions: {
        external,
      },
    },
  },
});
```

> [!CAUTION]
> Make sure to configure this shim or else local development won't work for server functions or middleware.
> ```ts
> // Provides a polyfill for Cloudflare Workers env during development
> cloudflareWorkersDevEnvironmentShim(),
> ```

## Modify DEPLOY_URL

Modify `./src/utils/users.tsx` to support non-local domains:

```ts
// must check if window is not undefined since the bundler also places this code server-side
export const DEPLOY_URL = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
```

## Deploy Your Application

Login to Cloudflare:

```sh
wrangler login
```

Run your Alchemy script to deploy the application:

```sh
bun ./alchemy.run
```

It should output the URL of your deployed site:

```sh
{
  url: "https://your-site.your-sub-domain.workers.dev",
}
```

Click the URL to see your TanStack Start application live!

## Local Development

To run your application locally, use the TanStack Start development server:

```sh
bun run dev
```

This will start a local development server with hot module reloading:

```sh
  VITE v5.0.10  ready in 237 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  press h + enter to show help
```

## Tear Down

When you're finished experimenting, you can tear down the application:

```bash
bun ./alchemy.run --destroy
```

This will remove all Cloudflare resources created by this deployment.
