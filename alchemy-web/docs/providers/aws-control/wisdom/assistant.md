---
title: Managing AWS Wisdom Assistants with Alchemy
description: Learn how to create, update, and manage AWS Wisdom Assistants using Alchemy Cloud Control.
---

# Assistant

The Assistant resource lets you create and manage [AWS Wisdom Assistants](https://docs.aws.amazon.com/wisdom/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-wisdom-assistant.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const assistant = await AWS.Wisdom.Assistant("assistant-example", {
  Type: "example-type",
  Name: "assistant-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A assistant resource managed by Alchemy",
});
```

## Advanced Configuration

Create a assistant with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAssistant = await AWS.Wisdom.Assistant("advanced-assistant", {
  Type: "example-type",
  Name: "assistant-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A assistant resource managed by Alchemy",
});
```

