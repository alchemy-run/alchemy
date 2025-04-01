# KV Namespace

The KV Namespace component allows you to create and manage [Cloudflare Workers KV](https://developers.cloudflare.com/workers/kv/) namespaces, which are key-value stores for your application.

# Minimal Example

```ts twoslash
import { KVNamespace } from "alchemy/cloudflare";

const users = await KVNamespace("users", {
  title: "user-data"
});
```

# Create the KV Namespace

```ts twoslash
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

```ts twoslash
import { Worker, KVNamespace } from "alchemy/cloudflare";

const myKVNamespace = await KVNamespace("my-kv-namespace", {
  title: "my-kv-data"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myKVNamespace,
  },
});
```