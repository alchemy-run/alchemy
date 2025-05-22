---
title: Managing AWS ApiGatewayV2 VpcLinks with Alchemy
description: Learn how to create, update, and manage AWS ApiGatewayV2 VpcLinks using Alchemy Cloud Control.
---

# VpcLink

The VpcLink resource lets you create and manage [AWS ApiGatewayV2 VpcLinks](https://docs.aws.amazon.com/apigatewayv2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigatewayv2-vpclink.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpclink = await AWS.ApiGatewayV2.VpcLink("vpclink-example", {
  SubnetIds: ["example-subnetids-1"],
  Name: "vpclink-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a vpclink with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVpcLink = await AWS.ApiGatewayV2.VpcLink("advanced-vpclink", {
  SubnetIds: ["example-subnetids-1"],
  Name: "vpclink-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

