---
title: Managing AWS Logs Deliverys with Alchemy
description: Learn how to create, update, and manage AWS Logs Deliverys using Alchemy Cloud Control.
---

# Delivery

The Delivery resource lets you create and manage [AWS Logs Deliverys](https://docs.aws.amazon.com/logs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-delivery.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const delivery = await AWS.Logs.Delivery("delivery-example", {
  DeliveryDestinationArn: "example-deliverydestinationarn",
  DeliverySourceName: "delivery-deliverysource",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a delivery with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDelivery = await AWS.Logs.Delivery("advanced-delivery", {
  DeliveryDestinationArn: "example-deliverydestinationarn",
  DeliverySourceName: "delivery-deliverysource",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

