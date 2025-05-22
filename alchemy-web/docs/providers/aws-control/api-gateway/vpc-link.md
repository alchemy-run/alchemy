---
title: Managing AWS ApiGateway VpcLinks with Alchemy
description: Learn how to create, update, and manage AWS ApiGateway VpcLinks using Alchemy Cloud Control.
---

# VpcLink

The VpcLink resource lets you create and manage [AWS ApiGateway VpcLinks](https://docs.aws.amazon.com/apigateway/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apigateway-vpclink.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpclink = await AWS.ApiGateway.VpcLink("vpclink-example", {
  TargetArns: ["example-targetarns-1"],
  Name: "vpclink-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A vpclink resource managed by Alchemy",
});
```

## Advanced Configuration

Create a vpclink with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVpcLink = await AWS.ApiGateway.VpcLink("advanced-vpclink", {
  TargetArns: ["example-targetarns-1"],
  Name: "vpclink-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A vpclink resource managed by Alchemy",
});
```

