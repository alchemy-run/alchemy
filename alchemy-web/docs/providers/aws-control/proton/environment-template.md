---
title: Managing AWS Proton EnvironmentTemplates with Alchemy
description: Learn how to create, update, and manage AWS Proton EnvironmentTemplates using Alchemy Cloud Control.
---

# EnvironmentTemplate

The EnvironmentTemplate resource lets you create and manage [AWS Proton EnvironmentTemplates](https://docs.aws.amazon.com/proton/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-proton-environmenttemplate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const environmenttemplate = await AWS.Proton.EnvironmentTemplate("environmenttemplate-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A environmenttemplate resource managed by Alchemy",
});
```

## Advanced Configuration

Create a environmenttemplate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEnvironmentTemplate = await AWS.Proton.EnvironmentTemplate(
  "advanced-environmenttemplate",
  {
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A environmenttemplate resource managed by Alchemy",
  }
);
```

