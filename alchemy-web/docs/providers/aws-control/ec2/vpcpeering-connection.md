---
title: Managing AWS EC2 VPCPeeringConnections with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPCPeeringConnections using Alchemy Cloud Control.
---

# VPCPeeringConnection

The VPCPeeringConnection resource lets you create and manage [AWS EC2 VPCPeeringConnections](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpcpeeringconnection.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpcpeeringconnection = await AWS.EC2.VPCPeeringConnection("vpcpeeringconnection-example", {
  VpcId: "example-vpcid",
  PeerVpcId: "example-peervpcid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a vpcpeeringconnection with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVPCPeeringConnection = await AWS.EC2.VPCPeeringConnection(
  "advanced-vpcpeeringconnection",
  {
    VpcId: "example-vpcid",
    PeerVpcId: "example-peervpcid",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

