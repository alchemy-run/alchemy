# State

The State component allows you to manage state using [Cloudflare Workers KV](https://developers.cloudflare.com/workers/runtime-apis/kv) as a storage backend.

# Minimal Example

```ts
import { CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* get your KVNamespace instance */;
const stateStore = new CloudflareStateStore(kvNamespace);
```

# Create the State

```ts
import { CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* get your KVNamespace instance */;
const stateStore = new CloudflareStateStore(kvNamespace, {
  prefix: "my-app-state:",
});
```

# Bind to a Worker

```ts
import { Worker, CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* get your KVNamespace instance */;
const stateStore = new CloudflareStateStore(kvNamespace, {
  prefix: "my-app-state:",
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    stateStore,
  },
});
```