# KV Namespace

A [Cloudflare KV Namespace](https://developers.cloudflare.com/kv/concepts/kv-namespaces/) is a key-value store that can be used to store data for your application.

# Minimal Example

Create a basic KV namespace for storing user data.

```ts
import { KVNamespace } from "alchemy/cloudflare";

const users = await KVNamespace("users", {
  title: "user-data"
});
```

# Create with Initial Values

Create a KV namespace with initial key-value pairs and TTL.

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

Bind a KV namespace to a Worker for data access.

```ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

const cache = await KVNamespace("cache", {
  title: "cache-store"
});

await Worker("api", {
  name: "api-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    CACHE: cache
  }
});
```