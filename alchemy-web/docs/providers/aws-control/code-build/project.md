---
title: Managing AWS CodeBuild Projects with Alchemy
description: Learn how to create, update, and manage AWS CodeBuild Projects using Alchemy Cloud Control.
---

# Project

The Project resource lets you create and manage [AWS CodeBuild Projects](https://docs.aws.amazon.com/codebuild/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codebuild-project.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const project = await AWS.CodeBuild.Project("project-example", {
  Source: "example-source",
  ServiceRole: "example-servicerole",
  Artifacts: "example-artifacts",
  Environment: "example-environment",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A project resource managed by Alchemy",
});
```

## Advanced Configuration

Create a project with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedProject = await AWS.CodeBuild.Project("advanced-project", {
  Source: "example-source",
  ServiceRole: "example-servicerole",
  Artifacts: "example-artifacts",
  Environment: "example-environment",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A project resource managed by Alchemy",
});
```

