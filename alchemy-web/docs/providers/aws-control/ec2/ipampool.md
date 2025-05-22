---
title: Managing AWS EC2 IPAMPools with Alchemy
description: Learn how to create, update, and manage AWS EC2 IPAMPools using Alchemy Cloud Control.
---

# IPAMPool

The IPAMPool resource lets you create and manage [AWS EC2 IPAMPools](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-ipampool.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ipampool = await AWS.EC2.IPAMPool("ipampool-example", {
  IpamScopeId: "example-ipamscopeid",
  AddressFamily: "example-addressfamily",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A ipampool resource managed by Alchemy",
});
```

## Advanced Configuration

Create a ipampool with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIPAMPool = await AWS.EC2.IPAMPool("advanced-ipampool", {
  IpamScopeId: "example-ipamscopeid",
  AddressFamily: "example-addressfamily",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A ipampool resource managed by Alchemy",
});
```

