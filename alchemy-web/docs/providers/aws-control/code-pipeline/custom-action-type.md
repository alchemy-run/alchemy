---
title: Managing AWS CodePipeline CustomActionTypes with Alchemy
description: Learn how to create, update, and manage AWS CodePipeline CustomActionTypes using Alchemy Cloud Control.
---

# CustomActionType

The CustomActionType resource lets you create and manage [AWS CodePipeline CustomActionTypes](https://docs.aws.amazon.com/codepipeline/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codepipeline-customactiontype.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const customactiontype = await AWS.CodePipeline.CustomActionType("customactiontype-example", {
  Category: "example-category",
  InputArtifactDetails: "example-inputartifactdetails",
  Version: "example-version",
  OutputArtifactDetails: "example-outputartifactdetails",
  Provider: "example-provider",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a customactiontype with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCustomActionType = await AWS.CodePipeline.CustomActionType(
  "advanced-customactiontype",
  {
    Category: "example-category",
    InputArtifactDetails: "example-inputartifactdetails",
    Version: "example-version",
    OutputArtifactDetails: "example-outputartifactdetails",
    Provider: "example-provider",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Settings: "example-settings",
  }
);
```

