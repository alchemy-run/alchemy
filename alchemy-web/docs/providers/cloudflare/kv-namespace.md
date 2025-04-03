# Kv Namespace

The Kv Namespace component allows you to create and manage [Cloudflare KV Namespaces](https://developers.cloudflare.com/kv/concepts/kv-namespaces/), which are key-value stores for your application.

# Minimal Example

```ts
import { KVNamespace } from "alchemy/cloudflare";

const users = await KVNamespace("users", {
  title: "user-data"
});
```

# Create the Kv Namespace

```ts
import { KVNamespace } from "alchemy/cloudflare";

const sessions = await KVNamespace("sessions", {
  title: "user-sessions",
  values: [{
    key: "session_123",
    value: { userId: "user_456", role: "admin" },
    expirationTtl: 3600 // Expires in 1 hour
  }]
});
```

# Bind to a Worker

```ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

const myResource = await KVNamespace("my-resource", {
  title: "my-resource"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myResource,
  },
});
```