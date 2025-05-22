---
title: Managing AWS Omics RunGroups with Alchemy
description: Learn how to create, update, and manage AWS Omics RunGroups using Alchemy Cloud Control.
---

# RunGroup

The RunGroup resource lets you create and manage [AWS Omics RunGroups](https://docs.aws.amazon.com/omics/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-omics-rungroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const rungroup = await AWS.Omics.RunGroup("rungroup-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a rungroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRunGroup = await AWS.Omics.RunGroup("advanced-rungroup", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

