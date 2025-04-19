# Worker

The [Worker](https://developers.cloudflare.com/workers/) resource lets you deploy serverless JavaScript/TypeScript functions to Cloudflare's global network.

# Minimal Example

Deploy a basic worker with an HTTP handler:

```ts
import { Worker } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker", 
  script: "export default { async fetch() { return new Response('Hello') } }"
});
```

# Worker with Bundling

Bundle and deploy a TypeScript worker:

```ts
import { Worker } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/worker.ts",
  bundle: {
    minify: true
  }
});
```

# Worker with Bindings

Bind KV namespaces, Durable Objects and other resources:

```ts
import { Worker, KVNamespace, DurableObjectNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("store", {
  title: "my-store"
});

const counter = new DurableObjectNamespace("counter", {
  className: "Counter"
});

const worker = await Worker("api", {
  name: "api-worker",
  script: "export default { async fetch() { return new Response('Hello') } }",
  bindings: {
    STORE: kv,
    COUNTER: counter
  }
});
```

# Worker with Custom Domain

Deploy a worker with a custom domain:

```ts
import { Worker, CustomDomain } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker",
  script: "export default { async fetch() { return new Response('Hello') } }"
});

const domain = await CustomDomain("api-domain", {
  name: "api.example.com",
  zoneId: "YOUR_ZONE_ID",
  workerName: worker.name
});
```

# Bind to a Worker

Bind a worker to another worker:

```ts
import { Worker } from "alchemy/cloudflare";

const backend = await Worker("backend", {
  name: "backend-worker",
  script: "export default { async fetch() { return new Response('Hello') } }"
});

const frontend = await Worker("frontend", {
  name: "frontend-worker", 
  script: "export default { async fetch() { return new Response('Hello') } }",
  bindings: {
    BACKEND: backend
  }
});
```