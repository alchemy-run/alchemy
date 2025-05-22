---
title: Managing AWS Redshift EventSubscriptions with Alchemy
description: Learn how to create, update, and manage AWS Redshift EventSubscriptions using Alchemy Cloud Control.
---

# EventSubscription

The EventSubscription resource lets you create and manage [AWS Redshift EventSubscriptions](https://docs.aws.amazon.com/redshift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-redshift-eventsubscription.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eventsubscription = await AWS.Redshift.EventSubscription("eventsubscription-example", {
  SubscriptionName: "eventsubscription-subscription",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a eventsubscription with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEventSubscription = await AWS.Redshift.EventSubscription(
  "advanced-eventsubscription",
  {
    SubscriptionName: "eventsubscription-subscription",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

