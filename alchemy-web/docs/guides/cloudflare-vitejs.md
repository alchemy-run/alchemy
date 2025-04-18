---
order: 1
---

# Cloudflare ViteJS

This guide demonstrates how to deploy a Vite.js React TypeScript application with a Hono API to Cloudflare using Alchemy.

## Create a new Vite.js Project

Start by creating a new Vite.js project:

```bash
bun create vite my-cloudflare-app --template react-ts
cd my-cloudflare-app
bun install
```

Install `cloudflare` and `alchemy`:
```sh
bun add alchemy cloudflare
```

Update your `tsconfig.json` to register `@cloudflare/workers-types` globally:

```json
{
  "compilerOptions": {
    // make sure to register this globally
    "types": ["@cloudflare/workers-types",],
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

## Create `alchemy.run.ts`

```ts
// ./alchemy.run.ts
import alchemy from "alchemy";

const app = await alchemy("cloudflare-vite", {
  stage: process.env.USER ?? "dev",
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
  quiet: process.argv.includes("--verbose") ? false : true,
});

// (resources go here)

await app.finalize(); // must be at end
```

> [!NOTE]
> See the [Getting Started](../getting-started) guide if this is unfamiliar.

## Create ViteSite

Import the `ViteSite` and configure your build command and assets directory:

```ts
import { ViteSite } from "alchemy/cloudflare";

export const website = await ViteSite("website", {
  // command to build the vite site (run vite build)
  command: "bun run build",
  // where the build command will store the assets
  assets: "./dist",
});
```

Log out the website's URL:
```ts
console.log({
  url: website.url
})
```

## Deploy Static Site

Login to Cloudflare:

```sh
wrangler login
```

Run `alchemy.run.ts` script to deploy:

```sh
bun ./alchemy.run
```

It should log out the URL of your deployed site:
```sh
{
  url: "https://your-site.your-sub-domain.workers.dev",
}
```

Click the endpoint to see your site!

## Add a Backend API

Create an entrypoint for your server, `src/index.ts`:

```ts
import { env } from "cloudflare:workers";

export default {
  async fetch(request: Request): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
};
```

> [!TIP]
> This basic entrypoint simply serves the static assets and was automatically injected by `ViteSite` when we did not specify `main`.

Update the `StaticSite` to use our custom server entrypoint:

```ts
export const website = await ViteSite("website", {
  command: "bun run build",
  assets: "./dist",
  // configure our server's entrypoint
  main: "./src/index.ts"
});
```

Now, create a `Hono` app for your api in `./src/api.ts`:

```ts
import { Hono } from "hono";

export const api = new Hono();

// create a route
api.get("/hello", (c) => c.text("Hello World"));
```

Modify `src/index.ts` to create another `Hono` app and route all `/api/*` requests to the API:

```ts
import { api } from "./api";
import { env } from "cloudflare:workers";
import { Hono } from "hono";

// create a root Hono app
const app = new Hono();

// and route /api/ to the api hono app
app.route("/api/", api);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      // route /api/* to our API
      return app.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
```

> [!TIP]
> You may be wondering why 2 Hono apps instead of 1.
>
> By using `app.route("/api/", api)`, we ensure all routes on `api` are under `/api/`:
> ```ts
> // no need to remember api.get("/api/hello")
> api.get("/hello", (c) => c.text("Hello World"));
> ```
>
> Now, a simple `if` statement is all it takes to differentiate between static asset and API requests:
>
> ```ts
> // makes it really easy to route non-static asset requests
> if (url.pathname.startsWith("/api/")) {
>   return app.fetch(request);
> }
> ```

## Infer Binding Types

Your server won't yet type check - first, we need to infer the binding types from our Worker by creating a `./src/env.d.ts` file:

```ts
/// <reference types="./env.d.ts" />

import type { website } from "./alchemy.run";

export type WorkerEnv = typeof website.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
```

> [!TIP]
> See the [Bindings](../concepts/bindings.md) documentation to learn more.

## Deploy Static Site and API

Re-run to deploy the new worker code:

```sh
bun ./alchemy.run
```

Test the API route is set up correctly with `curl`:

```sh
curl https://your-site.workers.dev/api/hello
```

It should output:
```
Hello World
```

> [!TIP]
> You can call this API from your frontend code with `fetch`:
>
> ```ts
> await fetch(`${window.origin}/api/hello`)
> ```

## Local Development

Edit the `./vite.config.ts` file and configure the `cloudflare()` plugin:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
});
```

Now you can run `vite dev`:
```sh
bun vite dev
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

That's it! You can now tear down the app (if you want to):

```bash
bun ./alchemy.run --destroy
```

