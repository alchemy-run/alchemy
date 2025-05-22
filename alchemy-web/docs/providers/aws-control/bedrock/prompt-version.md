---
title: Managing AWS Bedrock PromptVersions with Alchemy
description: Learn how to create, update, and manage AWS Bedrock PromptVersions using Alchemy Cloud Control.
---

# PromptVersion

The PromptVersion resource lets you create and manage [AWS Bedrock PromptVersions](https://docs.aws.amazon.com/bedrock/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-bedrock-promptversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const promptversion = await AWS.Bedrock.PromptVersion("promptversion-example", {
  PromptArn: "example-promptarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A promptversion resource managed by Alchemy",
});
```

## Advanced Configuration

Create a promptversion with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPromptVersion = await AWS.Bedrock.PromptVersion("advanced-promptversion", {
  PromptArn: "example-promptarn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A promptversion resource managed by Alchemy",
});
```

