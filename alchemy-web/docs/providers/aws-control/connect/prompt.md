---
title: Managing AWS Connect Prompts with Alchemy
description: Learn how to create, update, and manage AWS Connect Prompts using Alchemy Cloud Control.
---

# Prompt

The Prompt resource lets you create and manage [AWS Connect Prompts](https://docs.aws.amazon.com/connect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-connect-prompt.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const prompt = await AWS.Connect.Prompt("prompt-example", {
  InstanceArn: "example-instancearn",
  Name: "prompt-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A prompt resource managed by Alchemy",
});
```

## Advanced Configuration

Create a prompt with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPrompt = await AWS.Connect.Prompt("advanced-prompt", {
  InstanceArn: "example-instancearn",
  Name: "prompt-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A prompt resource managed by Alchemy",
});
```

