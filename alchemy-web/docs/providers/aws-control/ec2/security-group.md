---
title: Managing AWS EC2 SecurityGroups with Alchemy
description: Learn how to create, update, and manage AWS EC2 SecurityGroups using Alchemy Cloud Control.
---

# SecurityGroup

The SecurityGroup resource lets you create and manage [AWS EC2 SecurityGroups](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-securitygroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const securitygroup = await AWS.EC2.SecurityGroup("securitygroup-example", {
  GroupDescription: "A securitygroup resource managed by Alchemy",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a securitygroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSecurityGroup = await AWS.EC2.SecurityGroup("advanced-securitygroup", {
  GroupDescription: "A securitygroup resource managed by Alchemy",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

