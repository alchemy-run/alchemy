# State

The State component allows you to manage state using Cloudflare's KV Namespace, providing a scalable and distributed key-value store for your application. Learn more about [Cloudflare Workers KV](https://developers.cloudflare.com/workers/runtime-apis/kv).

# Minimal Example

```ts twoslash
import { CloudflareStateStore } from "alchemy/cloudflare/state";

const kvNamespace = /* your KV namespace instance */;
const stateStore = new CloudflareStateStore(kvNamespace, {
  prefix: "my-app-state:",
});
```

# Create the State

```ts twoslash
import { CloudflareStateStore } from "alchemy/cloudflare/state";

const kvNamespace = /* your KV namespace instance */;
const stateStore = new CloudflareStateStore(kvNamespace, {
  prefix: "my-app-state:",
});

// Initialize the state store
await stateStore.init();

// Set a state
await stateStore.set("user:123", { name: "Alice", age: 30 });

// Get a state
const userState = await stateStore.get("user:123");
console.log(userState);

// Delete a state
await stateStore.delete("user:123");
```

# Bind to a Worker

```ts twoslash
import { Worker, CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* your KV namespace instance */;
const stateStore = new CloudflareStateStore(kvNamespace, {
  prefix: "my-app-state:",
});

const myWorker = await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    stateStore,
  },
});
```