---
title: Managing AWS Wisdom AIPromptVersions with Alchemy
description: Learn how to create, update, and manage AWS Wisdom AIPromptVersions using Alchemy Cloud Control.
---

# AIPromptVersion

The AIPromptVersion resource lets you create and manage [AWS Wisdom AIPromptVersions](https://docs.aws.amazon.com/wisdom/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-wisdom-aipromptversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const aipromptversion = await AWS.Wisdom.AIPromptVersion("aipromptversion-example", {
  AssistantId: "example-assistantid",
  AIPromptId: "example-aipromptid",
});
```

