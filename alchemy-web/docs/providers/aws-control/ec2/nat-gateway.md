---
title: Managing AWS EC2 NatGateways with Alchemy
description: Learn how to create, update, and manage AWS EC2 NatGateways using Alchemy Cloud Control.
---

# NatGateway

The NatGateway resource lets you create and manage [AWS EC2 NatGateways](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-natgateway.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const natgateway = await AWS.EC2.NatGateway("natgateway-example", {
  SubnetId: "example-subnetid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a natgateway with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedNatGateway = await AWS.EC2.NatGateway("advanced-natgateway", {
  SubnetId: "example-subnetid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

