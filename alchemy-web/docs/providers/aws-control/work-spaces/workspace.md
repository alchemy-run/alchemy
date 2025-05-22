---
title: Managing AWS WorkSpaces Workspaces with Alchemy
description: Learn how to create, update, and manage AWS WorkSpaces Workspaces using Alchemy Cloud Control.
---

# Workspace

The Workspace resource lets you create and manage [AWS WorkSpaces Workspaces](https://docs.aws.amazon.com/workspaces/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-workspaces-workspace.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const workspace = await AWS.WorkSpaces.Workspace("workspace-example", {
  BundleId: "example-bundleid",
  DirectoryId: "example-directoryid",
  UserName: "workspace-user",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a workspace with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedWorkspace = await AWS.WorkSpaces.Workspace("advanced-workspace", {
  BundleId: "example-bundleid",
  DirectoryId: "example-directoryid",
  UserName: "workspace-user",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

