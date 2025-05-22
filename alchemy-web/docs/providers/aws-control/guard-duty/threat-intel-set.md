---
title: Managing AWS GuardDuty ThreatIntelSets with Alchemy
description: Learn how to create, update, and manage AWS GuardDuty ThreatIntelSets using Alchemy Cloud Control.
---

# ThreatIntelSet

The ThreatIntelSet resource lets you create and manage [AWS GuardDuty ThreatIntelSets](https://docs.aws.amazon.com/guardduty/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-guardduty-threatintelset.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const threatintelset = await AWS.GuardDuty.ThreatIntelSet("threatintelset-example", {
  Format: "example-format",
  Location: "example-location",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a threatintelset with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedThreatIntelSet = await AWS.GuardDuty.ThreatIntelSet("advanced-threatintelset", {
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

