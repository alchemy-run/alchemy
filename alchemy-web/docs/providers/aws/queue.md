# Queue

The Queue component allows you to create and manage [Amazon Simple Queue Service (SQS)](https://aws.amazon.com/sqs/) queues, supporting both standard and FIFO queues. SQS is a fully managed message queuing service that enables you to decouple and scale microservices, distributed systems, and serverless applications.

# Minimal Example

```ts
import { Queue } from "alchemy/aws";

const myQueue = await Queue("my-queue", {
  queueName: "my-queue",
});
```

# Create the Queue

```ts
import { Queue } from "alchemy/aws";

// Create a standard queue with custom visibility timeout
const standardQueue = await Queue("my-queue", {
  queueName: "my-queue",
  visibilityTimeout: 30,
  tags: {
    Environment: "production",
  },
});

// Create a FIFO queue with content-based deduplication
const fifoQueue = await Queue("orders-queue", {
  queueName: "orders-queue.fifo",
  fifo: true,
  contentBasedDeduplication: true,
  visibilityTimeout: 30,
  tags: {
    Environment: "production",
  },
});

// Create a queue with custom message retention and size
const customQueue = await Queue("large-messages", {
  queueName: "large-messages",
  messageRetentionPeriod: 345600,  // 4 days
  maximumMessageSize: 262144,      // 256 KB
  visibilityTimeout: 60,
  delaySeconds: 5,
  receiveMessageWaitTimeSeconds: 20,
});
```