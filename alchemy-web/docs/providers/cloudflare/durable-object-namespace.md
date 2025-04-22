# DurableObjectNamespace

A [Durable Object Namespace](https://developers.cloudflare.com/workers/runtime-apis/durable-objects/) provides a way to create stateful objects that persist across multiple requests in Cloudflare Workers.

# Minimal Example

Creates a basic Durable Object namespace for stateful chat rooms.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const rooms = new DurableObjectNamespace("chat-rooms", {
  className: "ChatRoom"
});
```

# With SQLite Storage

Creates a Durable Object with SQLite storage enabled for persistent data.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const users = new DurableObjectNamespace("user-store", {
  className: "User",
  sqlite: true
});
```

# With Script Name and Environment

Creates a Durable Object in a specific script and environment.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const game = new DurableObjectNamespace("game-state", {
  className: "GameState", 
  scriptName: "game-worker",
  environment: "production"
});
```

# Bind to a Worker

Binds a Durable Object namespace to a Worker.

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