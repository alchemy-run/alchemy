---
title: Managing AWS Macie FindingsFilters with Alchemy
description: Learn how to create, update, and manage AWS Macie FindingsFilters using Alchemy Cloud Control.
---

# FindingsFilter

The FindingsFilter resource lets you create and manage [AWS Macie FindingsFilters](https://docs.aws.amazon.com/macie/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-macie-findingsfilter.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const findingsfilter = await AWS.Macie.FindingsFilter("findingsfilter-example", {
  FindingCriteria: "example-findingcriteria",
  Name: "findingsfilter-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A findingsfilter resource managed by Alchemy",
});
```

## Advanced Configuration

Create a findingsfilter with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFindingsFilter = await AWS.Macie.FindingsFilter("advanced-findingsfilter", {
  FindingCriteria: "example-findingcriteria",
  Name: "findingsfilter-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A findingsfilter resource managed by Alchemy",
});
```

