---
title: Managing AWS Route53RecoveryReadiness ReadinessChecks with Alchemy
description: Learn how to create, update, and manage AWS Route53RecoveryReadiness ReadinessChecks using Alchemy Cloud Control.
---

# ReadinessCheck

The ReadinessCheck resource lets you create and manage [AWS Route53RecoveryReadiness ReadinessChecks](https://docs.aws.amazon.com/route53recoveryreadiness/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53recoveryreadiness-readinesscheck.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const readinesscheck = await AWS.Route53RecoveryReadiness.ReadinessCheck("readinesscheck-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a readinesscheck with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedReadinessCheck = await AWS.Route53RecoveryReadiness.ReadinessCheck(
  "advanced-readinesscheck",
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

