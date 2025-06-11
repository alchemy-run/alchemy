---
order: 1.4
title: Astro
description: Step-by-step guide to deploying Astro applications with server-side rendering to Cloudflare Workers using Alchemy's Infrastructure-as-Code approach.
---

# Astro

This guide demonstrates how to deploy an Astro application with server-side rendering to Cloudflare using Alchemy.

## Create a new Astro Project

Start by creating a new Astro project:

::: code-group

```sh [bun]
bun create astro@latest my-astro-app
cd my-astro-app
```

```sh [npm]
npm create astro@latest my-astro-app
cd my-astro-app
```

```sh [pnpm]
pnpm create astro@latest my-astro-app
cd my-astro-app
```

```sh [yarn]
yarn create astro@latest my-astro-app
cd my-astro-app
```

:::

When prompted:
- Choose "Just the basics" template
- Select "Yes" for TypeScript
- Choose "Strictest" for TypeScript configuration
- Select "Yes" for install dependencies
- Select "No" for git repository (we'll handle this separately)

## Install Cloudflare Adapter

Install the Cloudflare adapter and Alchemy dependencies:

::: code-group

```sh [bun]
bun add @astrojs/cloudflare
bun add -D alchemy cloudflare @cloudflare/workers-types
```

```sh [npm]
npm install @astrojs/cloudflare
npm install --save-dev alchemy cloudflare @cloudflare/workers-types
```

```sh [pnpm]
pnpm add @astrojs/cloudflare
pnpm add -D alchemy cloudflare @cloudflare/workers-types
```

```sh [yarn]
yarn add @astrojs/cloudflare
yarn add -D alchemy cloudflare @cloudflare/workers-types
```

:::

## Configure Astro for Cloudflare

Update your `astro.config.mjs` to use the Cloudflare adapter:

```js
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
});
```

## Create `alchemy.run.ts`

Create `alchemy.run.ts` to configure your deployment using Alchemy's Astro resource:

```ts
/// <reference types="node" />

import alchemy from "alchemy";
import { Astro, KVNamespace, R2Bucket } from "alchemy/cloudflare";

const app = await alchemy("cloudflare-astro", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

// Create some Cloudflare resources for your app
export const [storage, cache] = await Promise.all([
  R2Bucket("astro-storage", {
    allowPublicAccess: false,
  }),
  KVNamespace("CACHE", {
    title: "astro-cache",
  }),
]);

export const website = await Astro("astro-website", {
  command: "bun run build",
  bindings: {
    STORAGE: storage,
    CACHE: cache,
  },
});

console.log({
  url: website.url,
});

await app.finalize();
```

## Configure Alchemy Types

Create `src/env.d.ts` to properly type your Cloudflare bindings:

```ts
/// <reference types="astro/client" />

import type { website } from "../alchemy.run.ts";

type CloudflareEnv = typeof website.Env;

declare namespace App {
  interface Locals extends CloudflareEnv {}
}
```

## Add an API Route

Create `src/pages/api/hello.ts` to demonstrate server-side functionality:

```ts
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request }) => {
  // Access Cloudflare runtime context
  const runtime = request.cf;
  
  return new Response(JSON.stringify({
    message: "Hello from Astro API on Cloudflare!",
    timestamp: new Date().toISOString(),
    colo: runtime?.colo || "unknown",
    country: runtime?.country || "unknown",
    city: runtime?.city || "unknown",
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
};
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

## Deploy

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

Click the endpoint to see your site! Try visiting `/api/hello` to see the API endpoint in action.

## Local Development

Run the Astro development server:

::: code-group

```sh [bun]
bun run dev
```

```sh [npm]
npm run dev
```

```sh [pnpm]
pnpm run dev
```

```sh [yarn]
yarn run dev
```

:::

The Astro dev server will start:

```sh
🚀  astro  v5.1.3 ready in 892 ms

┃ Local    http://localhost:4321/
┃ Network  use --host to expose

┃ Watch mode enabled! Edit a file to see changes.
```

> [!TIP]
> For production-like local development with Cloudflare Workers, you can use `wrangler dev` after building your Astro site.

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