---
title: Managing AWS EC2 NetworkInterfaces with Alchemy
description: Learn how to create, update, and manage AWS EC2 NetworkInterfaces using Alchemy Cloud Control.
---

# NetworkInterface

The NetworkInterface resource lets you create and manage [AWS EC2 NetworkInterfaces](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-networkinterface.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const networkinterface = await AWS.EC2.NetworkInterface("networkinterface-example", {
  SubnetId: "example-subnetid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A networkinterface resource managed by Alchemy",
});
```

## Advanced Configuration

Create a networkinterface with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedNetworkInterface = await AWS.EC2.NetworkInterface("advanced-networkinterface", {
  SubnetId: "example-subnetid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A networkinterface resource managed by Alchemy",
});
```

