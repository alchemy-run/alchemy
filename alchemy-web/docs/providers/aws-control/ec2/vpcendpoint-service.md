---
title: Managing AWS EC2 VPCEndpointServices with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPCEndpointServices using Alchemy Cloud Control.
---

# VPCEndpointService

The VPCEndpointService resource lets you create and manage [AWS EC2 VPCEndpointServices](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpcendpointservice.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpcendpointservice = await AWS.EC2.VPCEndpointService("vpcendpointservice-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a vpcendpointservice with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVPCEndpointService = await AWS.EC2.VPCEndpointService("advanced-vpcendpointservice", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

