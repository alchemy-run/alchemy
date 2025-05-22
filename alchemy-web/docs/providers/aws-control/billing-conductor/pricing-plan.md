---
title: Managing AWS BillingConductor PricingPlans with Alchemy
description: Learn how to create, update, and manage AWS BillingConductor PricingPlans using Alchemy Cloud Control.
---

# PricingPlan

The PricingPlan resource lets you create and manage [AWS BillingConductor PricingPlans](https://docs.aws.amazon.com/billingconductor/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-billingconductor-pricingplan.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const pricingplan = await AWS.BillingConductor.PricingPlan("pricingplan-example", {
  Name: "pricingplan-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A pricingplan resource managed by Alchemy",
});
```

## Advanced Configuration

Create a pricingplan with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPricingPlan = await AWS.BillingConductor.PricingPlan("advanced-pricingplan", {
  Name: "pricingplan-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A pricingplan resource managed by Alchemy",
});
```

