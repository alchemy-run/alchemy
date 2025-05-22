---
title: Managing AWS QuickSight VPCConnections with Alchemy
description: Learn how to create, update, and manage AWS QuickSight VPCConnections using Alchemy Cloud Control.
---

# VPCConnection

The VPCConnection resource lets you create and manage [AWS QuickSight VPCConnections](https://docs.aws.amazon.com/quicksight/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-quicksight-vpcconnection.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpcconnection = await AWS.QuickSight.VPCConnection("vpcconnection-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a vpcconnection with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVPCConnection = await AWS.QuickSight.VPCConnection("advanced-vpcconnection", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

