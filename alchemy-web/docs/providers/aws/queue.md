# Queue

The Queue component lets you add [Amazon Simple Queue Service (SQS)](https://aws.amazon.com/sqs/) queues to your app.

# Minimal Example

Create a standard SQS queue with default settings.

```ts
import { Queue } from "alchemy/aws";

const queue = await Queue("my-queue", {
  queueName: "my-queue"
});
```

# Create a FIFO Queue

Create a FIFO queue with content-based deduplication enabled.

```ts
import { Queue } from "alchemy/aws";

const fifoQueue = await Queue("orders-queue", {
  queueName: "orders-queue.fifo", 
  fifo: true,
  contentBasedDeduplication: true,
  visibilityTimeout: 30,
  tags: {
    Environment: "production"
  }
});
```

# Configure Queue Settings

Create a queue with custom message retention and visibility settings.

```ts
import { Queue } from "alchemy/aws";

const customQueue = await Queue("large-messages", {
  queueName: "large-messages",
  messageRetentionPeriod: 345600, // 4 days
  maximumMessageSize: 262144,     // 256 KB
  visibilityTimeout: 60,
  delaySeconds: 5,
  receiveMessageWaitTimeSeconds: 20
});
```