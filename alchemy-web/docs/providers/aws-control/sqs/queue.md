---
title: Managing AWS SQS Queues with Alchemy
description: Learn how to create, update, and manage AWS SQS Queues using Alchemy Cloud Control.
---

# Queue

The Queue resource lets you create and manage [AWS SQS Queues](https://docs.aws.amazon.com/sqs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sqs-queue.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const queue = await AWS.SQS.Queue("queue-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a queue with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedQueue = await AWS.SQS.Queue("advanced-queue", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

