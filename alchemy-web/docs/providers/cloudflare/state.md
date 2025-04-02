# State

The State component allows you to manage state using [Cloudflare KV Namespace](https://developers.cloudflare.com/workers/runtime-apis/kv/), providing a scalable and distributed key-value store for your application.

# Minimal Example

```ts
import { CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* obtain KVNamespace instance */;
const stateStore = new CloudflareStateStore(kvNamespace, {
  prefix: "my-app-state:",
});
```

# Create the State

```ts
import { CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* obtain KVNamespace instance */;
const stateStore = new CloudflareStateStore(kvNamespace, {
  prefix: "my-app-state:",
});

// Initialize the state store
await stateStore.init();

// Set a state
await stateStore.set("user-123", { name: "Alice", age: 30 });

// Get a state
const userState = await stateStore.get("user-123");
console.log(userState);

// List all states
const allStates = await stateStore.all();
console.log(allStates);

// Delete a state
await stateStore.delete("user-123");
```

# Bind to a Worker

```ts
import { Worker, CloudflareStateStore } from "alchemy/cloudflare";

const kvNamespace = /* obtain KVNamespace instance */;
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