# WranglerJson

The WranglerJson resource creates and manages [wrangler.json configuration files](https://developers.cloudflare.com/workers/wrangler/configuration/) for Cloudflare Workers.

# Minimal Example

Create a basic wrangler.json file with required settings:

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src/index.ts"
});
```

# With KV and R2 Bindings

Configure a worker with KV namespaces and R2 bucket bindings:

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("api-config", {
  name: "api-worker",
  main: "src/api.ts",
  kv_namespaces: [
    {
      binding: "CACHE",
      id: "xxxx", 
      preview_id: "yyyy"
    }
  ],
  r2_buckets: [
    {
      binding: "STORAGE",
      bucket_name: "my-bucket"
    }
  ]
});
```

# With Durable Objects

Configure a worker with Durable Object bindings and migrations:

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("chat-config", {
  name: "chat-worker", 
  main: "src/chat.ts",
  durable_objects: {
    bindings: [
      {
        name: "ROOMS",
        class_name: "ChatRoom"
      }
    ]
  }
});
```

# With Custom Path

Specify a custom path for the wrangler.json file:

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("worker-config", {
  name: "my-worker",
  main: "src/index.ts",
  path: "./config/wrangler.json"
});
```