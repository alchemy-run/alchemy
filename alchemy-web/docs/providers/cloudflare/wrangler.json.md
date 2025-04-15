# WranglerJson

The WranglerJson resource generates a [wrangler.json configuration file](https://developers.cloudflare.com/workers/wrangler/configuration/) for a Cloudflare Worker.

## Minimal Example

Creates a basic wrangler.json file for a Worker:

```ts
import { Worker, WranglerJson } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/index.ts"
});

await WranglerJson("config", {
  worker
});
```

## With Custom Path

Specify a custom path for the wrangler.json file:

```ts
import { Worker, WranglerJson } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker", 
  entrypoint: "./src/index.ts"
});

await WranglerJson("config", {
  worker,
  path: "./config/wrangler.json"
});
```

## With Worker Bindings

Generate wrangler.json with Worker bindings configuration:

```ts
import { Worker, WranglerJson, KVNamespace, DurableObjectNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("store", {
  title: "my-store"
});

const counter = new DurableObjectNamespace("counter", {
  className: "Counter"
});

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/index.ts",
  bindings: {
    STORE: kv,
    COUNTER: counter
  }
});

await WranglerJson("config", {
  worker
});
```