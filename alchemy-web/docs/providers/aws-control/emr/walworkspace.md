---
title: Managing AWS EMR WALWorkspaces with Alchemy
description: Learn how to create, update, and manage AWS EMR WALWorkspaces using Alchemy Cloud Control.
---

# WALWorkspace

The WALWorkspace resource lets you create and manage [AWS EMR WALWorkspaces](https://docs.aws.amazon.com/emr/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-emr-walworkspace.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const walworkspace = await AWS.EMR.WALWorkspace("walworkspace-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a walworkspace with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedWALWorkspace = await AWS.EMR.WALWorkspace("advanced-walworkspace", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

