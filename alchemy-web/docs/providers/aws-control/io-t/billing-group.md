---
title: Managing AWS IoT BillingGroups with Alchemy
description: Learn how to create, update, and manage AWS IoT BillingGroups using Alchemy Cloud Control.
---

# BillingGroup

The BillingGroup resource lets you create and manage [AWS IoT BillingGroups](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-billinggroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const billinggroup = await AWS.IoT.BillingGroup("billinggroup-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a billinggroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedBillingGroup = await AWS.IoT.BillingGroup("advanced-billinggroup", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

