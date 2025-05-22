---
title: Managing AWS Amplify Branchs with Alchemy
description: Learn how to create, update, and manage AWS Amplify Branchs using Alchemy Cloud Control.
---

# Branch

The Branch resource lets you create and manage [AWS Amplify Branchs](https://docs.aws.amazon.com/amplify/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-amplify-branch.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const branch = await AWS.Amplify.Branch("branch-example", {
  AppId: "example-appid",
  BranchName: "branch-branch",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A branch resource managed by Alchemy",
});
```

## Advanced Configuration

Create a branch with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedBranch = await AWS.Amplify.Branch("advanced-branch", {
  AppId: "example-appid",
  BranchName: "branch-branch",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A branch resource managed by Alchemy",
});
```

