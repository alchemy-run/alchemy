---
title: Managing AWS AppRunner VpcConnectors with Alchemy
description: Learn how to create, update, and manage AWS AppRunner VpcConnectors using Alchemy Cloud Control.
---

# VpcConnector

The VpcConnector resource lets you create and manage [AWS AppRunner VpcConnectors](https://docs.aws.amazon.com/apprunner/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apprunner-vpcconnector.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpcconnector = await AWS.AppRunner.VpcConnector("vpcconnector-example", {
  Subnets: ["example-subnets-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a vpcconnector with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVpcConnector = await AWS.AppRunner.VpcConnector("advanced-vpcconnector", {
  Subnets: ["example-subnets-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

