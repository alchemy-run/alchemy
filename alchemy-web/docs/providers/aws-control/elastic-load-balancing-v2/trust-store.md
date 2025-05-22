---
title: Managing AWS Application Load Balancer TrustStores with Alchemy
description: Learn how to create, update, and manage AWS Application Load Balancer TrustStores using Alchemy Cloud Control.
---

# TrustStore

The TrustStore resource lets you create and manage [AWS Application Load Balancer TrustStores](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticloadbalancingv2-truststore.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const truststore = await AWS.ElasticLoadBalancingV2.TrustStore("truststore-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a truststore with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedTrustStore = await AWS.ElasticLoadBalancingV2.TrustStore("advanced-truststore", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

