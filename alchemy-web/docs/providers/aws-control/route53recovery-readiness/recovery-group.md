---
title: Managing AWS Route53RecoveryReadiness RecoveryGroups with Alchemy
description: Learn how to create, update, and manage AWS Route53RecoveryReadiness RecoveryGroups using Alchemy Cloud Control.
---

# RecoveryGroup

The RecoveryGroup resource lets you create and manage [AWS Route53RecoveryReadiness RecoveryGroups](https://docs.aws.amazon.com/route53recoveryreadiness/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53recoveryreadiness-recoverygroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const recoverygroup = await AWS.Route53RecoveryReadiness.RecoveryGroup("recoverygroup-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a recoverygroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRecoveryGroup = await AWS.Route53RecoveryReadiness.RecoveryGroup(
  "advanced-recoverygroup",
  {
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

