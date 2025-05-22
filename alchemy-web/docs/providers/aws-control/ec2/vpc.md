---
title: Managing AWS EC2 VPCs with Alchemy
description: Learn how to create, update, and manage AWS EC2 VPCs using Alchemy Cloud Control.
---

# VPC

The VPC resource lets you create and manage [AWS EC2 VPCs](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-vpc.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const vpc = await AWS.EC2.VPC("vpc-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a vpc with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVPC = await AWS.EC2.VPC("advanced-vpc", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

