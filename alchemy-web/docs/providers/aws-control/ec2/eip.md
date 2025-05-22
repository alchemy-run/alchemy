---
title: Managing AWS EC2 EIPs with Alchemy
description: Learn how to create, update, and manage AWS EC2 EIPs using Alchemy Cloud Control.
---

# EIP

The EIP resource lets you create and manage [AWS EC2 EIPs](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-eip.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eip = await AWS.EC2.EIP("eip-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a eip with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEIP = await AWS.EC2.EIP("advanced-eip", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

