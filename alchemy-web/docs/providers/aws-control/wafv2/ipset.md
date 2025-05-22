---
title: Managing AWS WAFv2 IPSets with Alchemy
description: Learn how to create, update, and manage AWS WAFv2 IPSets using Alchemy Cloud Control.
---

# IPSet

The IPSet resource lets you create and manage [AWS WAFv2 IPSets](https://docs.aws.amazon.com/wafv2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-wafv2-ipset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ipset = await AWS.WAFv2.IPSet("ipset-example", {
  Addresses: ["example-addresses-1"],
  Scope: "example-scope",
  IPAddressVersion: "example-ipaddressversion",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A ipset resource managed by Alchemy",
});
```

## Advanced Configuration

Create a ipset with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIPSet = await AWS.WAFv2.IPSet("advanced-ipset", {
  Addresses: ["example-addresses-1"],
  Scope: "example-scope",
  IPAddressVersion: "example-ipaddressversion",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A ipset resource managed by Alchemy",
});
```

