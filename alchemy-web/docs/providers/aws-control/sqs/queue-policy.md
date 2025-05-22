---
title: Managing AWS SQS QueuePolicys with Alchemy
description: Learn how to create, update, and manage AWS SQS QueuePolicys using Alchemy Cloud Control.
---

# QueuePolicy

The QueuePolicy resource lets you create and manage [AWS SQS QueuePolicys](https://docs.aws.amazon.com/sqs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sqs-queuepolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const queuepolicy = await AWS.SQS.QueuePolicy("queuepolicy-example", {
  PolicyDocument: {},
  Queues: ["example-queues-1"],
});
```

