---
title: Managing AWS Logs DeliverySources with Alchemy
description: Learn how to create, update, and manage AWS Logs DeliverySources using Alchemy Cloud Control.
---

# DeliverySource

The DeliverySource resource lets you create and manage [AWS Logs DeliverySources](https://docs.aws.amazon.com/logs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-deliverysource.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const deliverysource = await AWS.Logs.DeliverySource("deliverysource-example", {
  Name: "deliverysource-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a deliverysource with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDeliverySource = await AWS.Logs.DeliverySource("advanced-deliverysource", {
  Name: "deliverysource-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

