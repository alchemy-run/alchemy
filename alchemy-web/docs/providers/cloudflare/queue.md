# Queue

The Queue component lets you add [Cloudflare Queue](https://developers.cloudflare.com/queues/) to your app for reliable message delivery between workers.

# Minimal Example

Create a basic queue with default settings:

```ts
import { Queue } from "alchemy/cloudflare";

const queue = await Queue("my-queue", {
  name: "my-queue"
});
```

# Queue with Custom Settings

Configure queue delivery delay and retention period:

```ts
import { Queue } from "alchemy/cloudflare";

const queue = await Queue("delayed-queue", {
  name: "delayed-queue",
  settings: {
    deliveryDelay: 30, // 30 second delay
    messageRetentionPeriod: 86400 // Store messages for 1 day
  }
});
```

# Paused Queue

Create a paused queue that can be activated later:

```ts
import { Queue } from "alchemy/cloudflare";

const queue = await Queue("paused-queue", {
  name: "paused-queue", 
  settings: {
    deliveryPaused: true
  }
});
```

# Bind to a Worker

Use the queue in a Cloudflare Worker:

```ts
import { Worker, Queue } from "alchemy/cloudflare";

const myQueue = await Queue("my-queue", {
  name: "my-queue"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    MY_QUEUE: myQueue
  }
});
```