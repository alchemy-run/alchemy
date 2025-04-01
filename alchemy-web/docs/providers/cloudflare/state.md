# State

The State component allows you to manage state using [Cloudflare KV](https://developers.cloudflare.com/workers/runtime-apis/kv) as a backend for storing and retrieving state data.

# Minimal Example

```ts
import { CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* your KV namespace */;
const stateStore = new CloudflareStateStore(kvNamespace);
```

# Create the State

```ts
import { CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* your KV namespace */;
const stateStore = new CloudflareStateStore(kvNamespace, {
  prefix: "my-app-state:",
});
```

# Bind to a Worker

```ts
import { Worker, CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* your KV namespace */;
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