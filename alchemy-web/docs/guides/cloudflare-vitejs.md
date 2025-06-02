---
order: 1.5
title: Vite.js
description: Step-by-step guide to deploying Vite.js React applications with API endpoints to Cloudflare Workers using Alchemy's Infrastructure-as-Code approach.
---

# Vite

This guide demonstrates how to deploy a Vite.js React TypeScript application with a Hono API to Cloudflare using Alchemy.

## Create a new Vite.js Project

Start by creating a new Vite.js project:

::: code-group

```sh [bun]
bun create cloudflare@latest my-react-app --framework=react --platform=workers --no-deploy
```

```sh [npm]
npm create cloudflare@latest my-react-app -- --framework=react --platform=workers --no-deploy
```

```sh [pnpm]
pnpm create cloudflare@latest my-react-app -- --framework=react --platform=workers --no-deploy
```

```sh [yarn]
yarn create cloudflare@latest my-react-app -- --framework=react --platform=workers --no-deploy
```

:::

## Install dependencies:

::: code-group

```sh [bun]
bun add -D alchemy cloudflare @cloudflare/workers-types
```

```sh [npm]
npm install --save-dev alchemy cloudflare @cloudflare/workers-types
```

```sh [pnpm]
pnpm add -D alchemy cloudflare @cloudflare/workers-types
```

```sh [yarn]
yarn add -D alchemy cloudflare @cloudflare/workers-types
```

:::


## Remove Unnecessary files

Cloudflare's Vite.js template uses `wrangler.jsonc` and `wrangler types` to generate types which are not used by Alchemy.

Let's remove these:

```sh
rm -rf worker-configuration.d.ts wrangler.jsonc
```

## Create `alchemy.run.ts`

`alchemy.run.ts` can be thought of as kinda like the `wrangler.jsonc` except in pure TypeScript code.

Let's create it and use the `Vite` from `alchemy/cloudflare` to build and deploy our Vite.js project to Cloudflare.

```ts
/// <reference types="node" />

import alchemy from "alchemy";
import { Vite } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-vite", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const website = await Vite("vite-website", {
  main: "./worker/index.ts",
  command: "bun run build",
});

console.log({
  url: website.url,
});

await app.finalize();

```

## Configure Alchemy Types

As mentioned, Alchemy does not use `wrangler types` to generate `worker-configuration.d.ts` types. Instead, types are inferred from your Alchemy code directly.

To configure this, first create `./worker/env.ts` with the following content:

```ts
import type { website } from "../alchemy.run.ts";

export type CloudflareEnv = typeof website.Env;

declare global {
  type Env = CloudflareEnv
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
```

Then, replace `tsconfig.worker.json` with the following content:

```json
{
  "extends": "./tsconfig.node.json",
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.worker.tsbuildinfo",
    "types": ["@cloudflare/workers-types"],
  },
  "include": ["./worker"]
}

```

## Login to Cloudflare

Before you can deploy, you need to authenticate by running `wrangler login`.

::: code-group

```sh [bun]
bun wrangler login
```

```sh [npm]
npx wrangler login
```

```sh [pnpm]
pnpm wrangler login
```

```sh [yarn]
yarn wrangler login
```
:::

> [!TIP]
> Alchemy will by default try and use your wrangler OAuth token and Refresh Token to connect but see the [Cloudflare Auth](../guides/cloudflare-auth.md) for other methods.

## Deploy Static Site


Run `alchemy.run.ts` script to deploy:

::: code-group

```sh [bun]
bun ./alchemy.run
```

```sh [npm]
npx tsx ./alchemy.run
```

```sh [pnpm]
pnpm tsx ./alchemy.run
```

```sh [yarn]
yarn tsx ./alchemy.run
```

:::

It should log out the URL of your deployed site:
```sh
{
  url: "https://your-site.your-sub-domain.workers.dev",
}
```

Click the endpoint to see your site!

## Local Development

Cloudflare's Vite.js plugin can be run in `dev` mode:

::: code-group

```sh [bun]
bun vite dev
```

```sh [npm]
npx vite dev
```

```sh [pnpm]
pnpm vite dev
```

```sh [yarn]
yarn vite dev
```

:::

The vite dev server will start as normal, along with your Worker and Cloudflare Resources running locally in miniflare (matching a deployment as closely as possible).

```sh
VITE v6.2.2  ready in 1114 ms

➜  Local:   http://localhost:5173/
➜  Network: use --host to expose
➜  Debug:   http://localhost:5173/__debug
➜  press h + enter to show help
```

> [!TIP]
> Cloudflare's Vite.js plugin needs a `wrangler.jsonc` which Alchemy's `Vite` resource generates automatically.
> 
> You may wish to add it to `.gitignore`:
> ```
> # .gitignore
> wrangler.jsonc
> ```

## Tear Down

That's it! You can now tear down the app (if you want to):

::: code-group

```sh [bun]
bun ./alchemy.run --destroy
```

```sh [npm]
npx tsx ./alchemy.run --destroy
```

```sh [pnpm]
pnpm tsx ./alchemy.run --destroy
```

```sh [yarn]
yarn tsx ./alchemy.run --destroy
```

:::

