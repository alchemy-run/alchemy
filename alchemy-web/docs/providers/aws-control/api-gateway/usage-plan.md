---
title: Managing AWS ApiGateway UsagePlans with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway UsagePlans using Alchemy Cloud Control.
---

# UsagePlan

The UsagePlan resource lets you create and manage [AWS ApiGateway UsagePlans](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-usageplan.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const usageplan = await AWS.ApiGateway.UsagePlan("usageplan-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A usageplan resource managed by Alchemy",
});
```

## Advanced Configuration

Create a usageplan with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedUsagePlan = await AWS.ApiGateway.UsagePlan("advanced-usageplan", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A usageplan resource managed by Alchemy",
});
```

