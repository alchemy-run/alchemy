# KV Namespace

A [Cloudflare KV Namespace](https://developers.cloudflare.com/kv/concepts/kv-namespaces/) provides low-latency key-value storage that is globally distributed and eventually consistent.

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

Bind a KV namespace to a Worker for use in your application code.

```ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

const sessions = await KVNamespace("sessions", {
  title: "user-sessions"
});

await Worker("auth", {
  name: "auth-worker", 
  script: "export default { fetch() {} }",
  bindings: {
    SESSIONS: sessions
  }
});
```