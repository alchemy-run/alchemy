---
title: Managing AWS EC2 Subnets with Alchemy
description: Learn how to create, update, and manage AWS EC2 Subnets using Alchemy Cloud Control.
---

# Subnet

The Subnet resource lets you create and manage [AWS EC2 Subnets](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-subnet.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const subnet = await AWS.EC2.Subnet("subnet-example", {
  VpcId: "example-vpcid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a subnet with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSubnet = await AWS.EC2.Subnet("advanced-subnet", {
  VpcId: "example-vpcid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

