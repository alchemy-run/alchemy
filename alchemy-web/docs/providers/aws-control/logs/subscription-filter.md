---
title: Managing AWS Logs SubscriptionFilters with Alchemy
description: Learn how to create, update, and manage AWS Logs SubscriptionFilters using Alchemy Cloud Control.
---

# SubscriptionFilter

The SubscriptionFilter resource lets you create and manage [AWS Logs SubscriptionFilters](https://docs.aws.amazon.com/logs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-subscriptionfilter.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const subscriptionfilter = await AWS.Logs.SubscriptionFilter("subscriptionfilter-example", {
  FilterPattern: "example-filterpattern",
  LogGroupName: "subscriptionfilter-loggroup",
  DestinationArn: "example-destinationarn",
});
```

