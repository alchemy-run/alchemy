---
title: Managing AWS ElastiCache SecurityGroups with Alchemy
description: Learn how to create, update, and manage AWS ElastiCache SecurityGroups using Alchemy Cloud Control.
---

# SecurityGroup

The SecurityGroup resource lets you create and manage [AWS ElastiCache SecurityGroups](https://docs.aws.amazon.com/elasticache/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-elasticache-security-group.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const securitygroup = await AWS.ElastiCache.SecurityGroup("securitygroup-example", {
  Description: "A securitygroup resource managed by Alchemy",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a securitygroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSecurityGroup = await AWS.ElastiCache.SecurityGroup("advanced-securitygroup", {
  Description: "A securitygroup resource managed by Alchemy",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

