---
title: Managing AWS SSM PatchBaselines with Alchemy
description: Learn how to create, update, and manage AWS SSM PatchBaselines using Alchemy Cloud Control.
---

# PatchBaseline

The PatchBaseline resource lets you create and manage [AWS SSM PatchBaselines](https://docs.aws.amazon.com/ssm/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-patchbaseline.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const patchbaseline = await AWS.SSM.PatchBaseline("patchbaseline-example", {
  Name: "patchbaseline-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A patchbaseline resource managed by Alchemy",
});
```

## Advanced Configuration

Create a patchbaseline with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPatchBaseline = await AWS.SSM.PatchBaseline("advanced-patchbaseline", {
  Name: "patchbaseline-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A patchbaseline resource managed by Alchemy",
});
```

