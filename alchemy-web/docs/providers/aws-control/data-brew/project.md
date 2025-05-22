---
title: Managing AWS DataBrew Projects with Alchemy
description: Learn how to create, update, and manage AWS DataBrew Projects using Alchemy Cloud Control.
---

# Project

The Project resource lets you create and manage [AWS DataBrew Projects](https://docs.aws.amazon.com/databrew/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-databrew-project.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const project = await AWS.DataBrew.Project("project-example", {
  RecipeName: "project-recipe",
  DatasetName: "project-dataset",
  RoleArn: "example-rolearn",
  Name: "project-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a project with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedProject = await AWS.DataBrew.Project("advanced-project", {
  RecipeName: "project-recipe",
  DatasetName: "project-dataset",
  RoleArn: "example-rolearn",
  Name: "project-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

