---
title: Managing AWS GuardDuty Filters with Alchemy
description: Learn how to create, update, and manage AWS GuardDuty Filters using Alchemy Cloud Control.
---

# Filter

The Filter resource lets you create and manage [AWS GuardDuty Filters](https://docs.aws.amazon.com/guardduty/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-guardduty-filter.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const filter = await AWS.GuardDuty.Filter("filter-example", {
  DetectorId: "example-detectorid",
  FindingCriteria: "example-findingcriteria",
  Name: "filter-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A filter resource managed by Alchemy",
});
```

## Advanced Configuration

Create a filter with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFilter = await AWS.GuardDuty.Filter("advanced-filter", {
  DetectorId: "example-detectorid",
  FindingCriteria: "example-findingcriteria",
  Name: "filter-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A filter resource managed by Alchemy",
});
```

