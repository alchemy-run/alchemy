---
order: 1
---

# Cloudflare ViteJS

This guide shows how to deploy a Vite.js React TypeScript application to Cloudflare using Alchemy.

## Create a new Vite.js Project

Start by creating a new Vite.js project:

```bash
bun create vite my-cloudflare-app --template react-ts
cd my-cloudflare-app
bun install
```

## Set up Cloudflare Credentials

Create a `.env` file in the root of the new project and place your Cloudflare Account's Email and API Key:

```
CLOUDFLARE_API_KEY=<your-api-key>
CLOUDFLARE_EMAIL=<account-email>
```

> [!TIP]
> Use the "Global API Key" from https://dash.cloudflare.com/profile/api-tokens

## Create `alchemy.run.ts`

Create a standard `alchemy.run.ts` file in your project root:

```typescript
import "@types/node";
import alchemy from "alchemy";

const app = await alchemy("cloudflare-vite", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: process.argv.includes("--verbose") ? false : true,
});
```

> [!NOTE]
> See the [Getting Started](../getting-started) guide if this is unfamiliar.

## Build Vite.js

We're using a ViteJS site that needs to be built to create a `./dist` folder.

For this, we'll use the `Exec` command from `alchemy/os`:

```typescript
import { Exec } from "alchemy/os";

await Exec("build", {
  // executes the tsc -b and vite build commands
  command: "bun run build",
});
```

## Create Cloudflare Assets

Now that we've built our website's assets, we need to create an `Assets` Resource to store them in our Cloudflare Worker.

```typescript
import { Assets } from "alchemy/cloudflare";

const staticAssets = await Assets("static-assets", {
  path: "./dist", // Path to your Vite build output
});
```

## Create the Worker & Bind to Assets

Now bind the static assets to our worker so we can serve them using Cloudflare's CDN.

```typescript
import { Worker } from "alchemy/cloudflare";

export const website = await Worker("worker", {
  name: "my-cloudflare-app",
  entrypoint: "./src/index.ts",
  url: true,
  bindings: {
    // bind the static assets to `env.ASSETS`
    ASSETS: staticAssets,
  },
});

console.log({
  url: website.url,
});

// this is the end of the infra script - call finalize
await app.finalize();
```

## Create the Worker Entrypoint

Now create a `src/index.ts` file where you'll implement your server's entrypoint:

```typescript
import { env } from "cloudflare:workers";

export default {
  async fetch(request: Request): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
```

## Configure the Worker Environment Types

Your server won't yet compile - first, we need to set up the types for our Worker's Environment.

For that, create a `./src/env.d.ts` file and place the following:

```typescript
// src/env.d.ts
import type { website } from "./alchemy.run";

export type WorkerEnv = typeof website.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
```

> [!TIP]
> See the [Type-safe Bindings](../concepts/bindings#type-safe-bindings) documentation for more information.

## Deploy the Website

```sh
bun ./alchemy.run
```

It'll log out our URL
```json
"https://${...}.workers.dev"
```

Click it, you should see your site!

## Add an API Endpoint

Now, what good's a site without an API to back it? Let's now set that up.

First, let's set up a basic Hono app to handle our API router:

```typescript
// src/api.ts
import { Hono } from "hono";

export const api = new Hono();

// API route
api.get("/hello", (c) => c.text("Hello"));
```

Then, in our `src/index.ts` server, set up the "root" hono app and route `/api/` to it.
```ts
// src/index.ts
import { Hono } from "hono";
import { env } from "cloudflare:workers";
import { api } from "./api";

const app = new Hono();

// mount the api on the "/api/" route so we can easily differentiate it
app.route("/api/", api);
```

> [!TIP]
> It's a good practice to use `app.route` to partition routes behind a prefix like `/api/` to simplify routing (see below)

Finally, update your `fetch` request handler:
```ts
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request);
    }

    // otherwise, assume it's a static asset
    return env.ASSETS.fetch(request);
  },
};
```

## Deploy the Site + API

```sh
bun ./alchemy.run
```

## Re-deploy

Deploy your app to Cloudflare:

```bash
bun ./alchemy.run
```

It'll log out our URL
```json
"https://${...}.workers.dev"
```

Try hitting the API with `curl`:

```sh
$ curl https://your-endpoint.workers.dev/api/hello
hello world
```

## Local Development

Until now, we've been deploying directly to Cloudflare, but this is inconvenient for testing.

> [!TIP]
> Luckily, Cloudflare has a Vite plugin to run your Worker and other Cloudflare Resources locally when you run `vite dev`.

> [!CAUTION]
> Unluckily, it depends on a `wrangler.json` file, which we don't have because we're using Alchemy instead of Wrangler!

As a workaround, use the `WranglerJson` Resource to generate `wrangler.json` from your `Worker` in your `alchemy.run.ts` script:

```ts
import { WranglerJson } from "alchemy/cloudflare";

await WranglerJson("wrangler.json", {
  worker: website
})
```

Then re-deploy:
```sh
bun ./alchemy.run
```

This will generate a `./wrangler.json` file:
```json
{
  "name": "alchemy-example-vite-api",
  "main": "./src/index.ts",
  "format": "esm",
  "compatibility_date": "2022-04-05",
  "assets": { 
    "directory": "./dist",
    "binding": "ASSETS"
  }
}
```

Now, edit the `./vite.config.ts` file and configure the `cloudflare()` plugin:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
});
```

Finally, run `vite dev` 
```sh
vite dev
```

The vite dev server will start as normal, along with your Worker and Cloudflare Resources running locally in miniflare (matching a deployment as closely as possible).

```sh
VITE v6.2.2  ready in 1114 ms

➜  Local:   http://localhost:5173/
➜  Network: use --host to expose
➜  Debug:   http://localhost:5173/__debug
➜  press h + enter to show help
```

## Tear Down

That's it! You can now tear down the app:

```bash
bun ./alchemy.run --destroy
```

