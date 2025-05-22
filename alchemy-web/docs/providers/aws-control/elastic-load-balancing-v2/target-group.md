---
title: Managing AWS Application Load Balancer TargetGroups with Alchemy
description: Learn how to create, update, and manage AWS Application Load Balancer TargetGroups using Alchemy Cloud Control.
---

# TargetGroup

The TargetGroup resource lets you create and manage [AWS Application Load Balancer TargetGroups](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticloadbalancingv2-targetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const targetgroup = await AWS.ElasticLoadBalancingV2.TargetGroup("targetgroup-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a targetgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTargetGroup = await AWS.ElasticLoadBalancingV2.TargetGroup("advanced-targetgroup", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

