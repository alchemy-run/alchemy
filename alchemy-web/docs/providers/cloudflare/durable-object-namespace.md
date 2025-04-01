# Durable Object Namespace

The Durable Object Namespace component allows you to create and manage [Cloudflare Durable Objects](https://developers.cloudflare.com/workers/learning/using-durable-objects) for stateful applications.

# Minimal Example

```ts twoslash
import { DurableObjectNamespace } from "alchemy/cloudflare";

const chatRooms = new DurableObjectNamespace("chat-rooms", {
  className: "ChatRoom"
});
```

# Create the Durable Object Namespace

```ts twoslash
import { DurableObjectNamespace } from "alchemy/cloudflare";

const userStore = new DurableObjectNamespace("user-store", {
  className: "User",
  sqlite: true
});
```

# Bind to a Worker

```ts twoslash
import { Worker, DurableObjectNamespace } from "alchemy/cloudflare";

const gameState = await DurableObjectNamespace("game-state", {
  className: "GameState",
  scriptName: "game-worker",
  environment: "production"
});

await Worker("game-worker", {
  name: "game-worker",
  script: "console.log('Game worker initialized')",
  bindings: {
    gameState,
  },
});
```