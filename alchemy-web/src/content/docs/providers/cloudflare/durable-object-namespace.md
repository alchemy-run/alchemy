---
title: DurableObjectNamespace
description: Learn how to create and manage Cloudflare Durable Object Namespaces using Alchemy for stateful serverless applications.
---

A [Durable Object Namespace](https://developers.cloudflare.com/workers/runtime-apis/durable-objects/) represents a globally unique namespace for Durable Objects that provide strongly consistent storage and coordination.

## Minimal Example

Create a basic Durable Object namespace for stateful chat rooms.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const rooms = DurableObjectNamespace("chat-rooms", {
  className: "ChatRoom",
});
```

## Create with SQLite Storage

Create a Durable Object with SQLite storage for user data.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const users = DurableObjectNamespace("user-store", {
  className: "User",
  sqlite: true,
});
```

## Create in Production Environment

Create a Durable Object in production for game state management.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const game = DurableObjectNamespace("game-state", {
  className: "GameState",
  scriptName: "game-worker",
  environment: "production",
});
```

## Bind to a Worker

Bind a Durable Object namespace to a Worker to enable access.

```ts
import { Worker, DurableObjectNamespace } from "alchemy/cloudflare";

const counter = DurableObjectNamespace("counter", {
  className: "Counter",
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    COUNTER: counter,
  },
});
```

## Rename Class Name

Alchemy takes care of migrations automatically when you rename the class name.

```diff lang='ts'
 import { DurableObjectNamespace } from "alchemy/cloudflare";

 const counter = DurableObjectNamespace("counter", {
-  className: "Counter",
+  className: "MyCounter",
   sqlite: true,
 });
```

:::caution
You cannot rename the `"counter"` ID in `DurableObjectNamespace("counter")` - we call this the "stable identifier" for the Durable Object and it is immutable for the lifetime of the application.
:::

## Cross-Script Binding

You can share Durable Objects across multiple Workers, allowing one Worker to access Durable Object instances defined in another Worker.

### Method 1: Using re-exported syntax

You can directly reference the Durable Object binding from the provider Worker:

```ts
import { Worker, DurableObjectNamespace } from "alchemy/cloudflare";

// Create the provider Worker with the Durable Object
const host = await Worker("Host", {
  entrypoint: "./do-provider.ts",
  bindings: {
    SHARED_COUNTER: DurableObjectNamespace("shared-counter", {
      className: "SharedCounter",
      sqlite: true,
    }),
  },
});

// Create the client Worker using the provider's Durable Object binding directly
const client = await Worker("client", {
  entrypoint: "./client-worker.ts",
  bindings: {
    // Re-use the exact same Durable Object binding from the provider worker
    SHARED_COUNTER: host.bindings.SHARED_COUNTER,
  },
});
```

### Method 2: Using `scriptName` directly

Alternatively, when creating a Durable Object binding in a client Worker, you can reference a Durable Object defined in another Worker by specifying the `scriptName`:

```ts
import { Worker, DurableObjectNamespace } from "alchemy/cloudflare";

const hostWorkerName = "host";

const durableObject = DurableObjectNamespace("shared-counter", {
  className: "SharedCounter",
  scriptName: hostWorkerName,
  sqlite: true,
});

// First, create the Worker that defines the Durable Object
const host = await Worker("host", {
  entrypoint: "./do-provider.ts",
  name: hostWorkerName,
  bindings: {
    // Define the Durable Object in this worker
    SHARED_COUNTER: durableObject,
  },
});

// Then, create a client Worker that uses the cross-script Durable Object
const client = await Worker("client", {
  entrypoint: "./client-worker.ts",
  bindings: {
    // Reference the same Durable Object but specify which script it comes from
    SHARED_COUNTER: durableObject,
  },
});
```