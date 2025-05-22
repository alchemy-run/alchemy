---
title: Managing AWS SQS QueueInlinePolicys with Alchemy
description: Learn how to create, update, and manage AWS SQS QueueInlinePolicys using Alchemy Cloud Control.
---

# QueueInlinePolicy

The QueueInlinePolicy resource lets you create and manage [AWS SQS QueueInlinePolicys](https://docs.aws.amazon.com/sqs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sqs-queueinlinepolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const queueinlinepolicy = await AWS.SQS.QueueInlinePolicy("queueinlinepolicy-example", {
  PolicyDocument: {},
  Queue: "example-queue",
});
```

