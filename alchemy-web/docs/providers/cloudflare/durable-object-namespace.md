# DurableObjectNamespace

A [Durable Object Namespace](https://developers.cloudflare.com/workers/runtime-apis/durable-objects/) lets you create stateful objects that persist data across multiple Worker requests.

# Minimal Example

Create a basic Durable Object namespace for stateful chat rooms:

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const rooms = new DurableObjectNamespace("chat-rooms", {
  className: "ChatRoom"
});
```

# With SQLite Storage

Create a Durable Object with SQLite storage for user data:

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const users = new DurableObjectNamespace("user-store", {
  className: "User",
  sqlite: true
});
```

# Production Environment

Create a Durable Object in production for game state management:

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const game = new DurableObjectNamespace("game-state", {
  className: "GameState", 
  scriptName: "game-worker",
  environment: "production"
});
```

# Bind to a Worker

Bind a Durable Object namespace to a Worker:

```ts
import { Worker, DurableObjectNamespace } from "alchemy/cloudflare";

const rooms = new DurableObjectNamespace("chat-rooms", {
  className: "ChatRoom"
});

await Worker("chat", {
  name: "chat-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    ROOMS: rooms
  }
});
```