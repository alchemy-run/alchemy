---
title: Managing AWS GuardDuty IPSets with Alchemy
description: Learn how to create, update, and manage AWS GuardDuty IPSets using Alchemy Cloud Control.
---

# IPSet

The IPSet resource lets you create and manage [AWS GuardDuty IPSets](https://docs.aws.amazon.com/guardduty/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-guardduty-ipset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const ipset = await AWS.GuardDuty.IPSet("ipset-example", {
  Format: "example-format",
  Location: "example-location",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a ipset with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIPSet = await AWS.GuardDuty.IPSet("advanced-ipset", {
  Format: "example-format",
  Location: "example-location",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

