# DurableObjectNamespace

A [Durable Object Namespace](https://developers.cloudflare.com/workers/runtime-apis/durable-objects/) provides a way to create stateful objects that can coordinate across multiple Workers.

# Minimal Example

Creates a basic Durable Object namespace for stateful chat rooms.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const rooms = new DurableObjectNamespace("chat-rooms", {
  className: "ChatRoom"
});
```

# With SQLite Storage

Creates a Durable Object with SQLite storage enabled for user data.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const users = new DurableObjectNamespace("user-store", {
  className: "User",
  sqlite: true
});
```

# With Environment and Script Name

Creates a Durable Object in production with specific script name.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const game = new DurableObjectNamespace("game-state", {
  className: "GameState", 
  scriptName: "game-worker",
  environment: "production"
});
```

# Bind to a Worker

Binds the Durable Object namespace to a Worker.

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