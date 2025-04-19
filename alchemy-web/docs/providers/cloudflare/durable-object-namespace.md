# DurableObjectNamespace

A [Durable Object Namespace](https://developers.cloudflare.com/durable-objects/) allows you to create stateful objects that persist data across multiple Worker invocations.

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

# With Environment and Script Name

Create a Durable Object in production with a specific script:

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