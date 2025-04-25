# DurableObjectNamespace

A [Durable Object Namespace](https://developers.cloudflare.com/workers/runtime-apis/durable-objects/) represents a globally unique namespace for Durable Objects that provide strongly consistent storage and coordination.

# Minimal Example

Create a basic Durable Object namespace for stateful chat rooms.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const rooms = new DurableObjectNamespace("chat-rooms", {
  className: "ChatRoom"
});
```

# Create with SQLite Storage

Create a Durable Object with SQLite storage for user data.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const users = new DurableObjectNamespace("user-store", {
  className: "User",
  sqlite: true
});
```

# Create in Production Environment

Create a Durable Object in production for game state management.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const game = new DurableObjectNamespace("game-state", {
  className: "GameState", 
  scriptName: "game-worker",
  environment: "production"
});
```

# Bind to a Worker

Bind a Durable Object namespace to a Worker to enable access.

```ts
import { Worker, DurableObjectNamespace } from "alchemy/cloudflare";

const counter = new DurableObjectNamespace("counter", {
  className: "Counter"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    COUNTER: counter
  }
});
```