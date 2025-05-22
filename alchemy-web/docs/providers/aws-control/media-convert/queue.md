---
title: Managing AWS MediaConvert Queues with Alchemy
description: Learn how to create, update, and manage AWS MediaConvert Queues using Alchemy Cloud Control.
---

# Queue

The Queue resource lets you create and manage [AWS MediaConvert Queues](https://docs.aws.amazon.com/mediaconvert/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-mediaconvert-queue.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const queue = await AWS.MediaConvert.Queue("queue-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A queue resource managed by Alchemy",
});
```

## Advanced Configuration

Create a queue with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedQueue = await AWS.MediaConvert.Queue("advanced-queue", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A queue resource managed by Alchemy",
});
```

