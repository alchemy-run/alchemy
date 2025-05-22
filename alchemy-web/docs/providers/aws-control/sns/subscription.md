---
title: Managing AWS SNS Subscriptions with Alchemy
description: Learn how to create, update, and manage AWS SNS Subscriptions using Alchemy Cloud Control.
---

# Subscription

The Subscription resource lets you create and manage [AWS SNS Subscriptions](https://docs.aws.amazon.com/sns/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sns-subscription.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const subscription = await AWS.SNS.Subscription("subscription-example", {
  TopicArn: "example-topicarn",
  Protocol: "example-protocol",
});
```

