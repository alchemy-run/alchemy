---
title: Managing AWS ImageBuilder ContainerRecipes with Alchemy
description: Learn how to create, update, and manage AWS ImageBuilder ContainerRecipes using Alchemy Cloud Control.
---

# ContainerRecipe

The ContainerRecipe resource lets you create and manage [AWS ImageBuilder ContainerRecipes](https://docs.aws.amazon.com/imagebuilder/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-containerrecipe.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const containerrecipe = await AWS.ImageBuilder.ContainerRecipe("containerrecipe-example", {
  ParentImage: "example-parentimage",
  ContainerType: "example-containertype",
  Name: "containerrecipe-",
  Components: [],
  TargetRepository: "example-targetrepository",
  Version: "example-version",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A containerrecipe resource managed by Alchemy",
});
```

## Advanced Configuration

Create a containerrecipe with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedContainerRecipe = await AWS.ImageBuilder.ContainerRecipe("advanced-containerrecipe", {
  ParentImage: "example-parentimage",
  ContainerType: "example-containertype",
  Name: "containerrecipe-",
  Components: [],
  TargetRepository: "example-targetrepository",
  Version: "example-version",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A containerrecipe resource managed by Alchemy",
});
```

