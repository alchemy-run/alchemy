---
title: Managing AWS Events EventBuss with Alchemy
description: Learn how to create, update, and manage AWS Events EventBuss using Alchemy Cloud Control.
---

# EventBus

The EventBus resource lets you create and manage [AWS Events EventBuss](https://docs.aws.amazon.com/events/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-events-eventbus.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eventbus = await AWS.Events.EventBus("eventbus-example", {
  Name: "eventbus-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A eventbus resource managed by Alchemy",
});
```

## Advanced Configuration

Create a eventbus with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEventBus = await AWS.Events.EventBus("advanced-eventbus", {
  Name: "eventbus-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A eventbus resource managed by Alchemy",
  Policy: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }],
  },
});
```

