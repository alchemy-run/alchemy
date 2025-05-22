---
title: Managing AWS DMS EventSubscriptions with Alchemy
description: Learn how to create, update, and manage AWS DMS EventSubscriptions using Alchemy Cloud Control.
---

# EventSubscription

The EventSubscription resource lets you create and manage [AWS DMS EventSubscriptions](https://docs.aws.amazon.com/dms/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dms-eventsubscription.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eventsubscription = await AWS.DMS.EventSubscription("eventsubscription-example", {
  SnsTopicArn: "example-snstopicarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a eventsubscription with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEventSubscription = await AWS.DMS.EventSubscription("advanced-eventsubscription", {
  SnsTopicArn: "example-snstopicarn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

