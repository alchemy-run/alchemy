---
title: Managing AWS Wisdom AIGuardrailVersions with Alchemy
description: Learn how to create, update, and manage AWS Wisdom AIGuardrailVersions using Alchemy Cloud Control.
---

# AIGuardrailVersion

The AIGuardrailVersion resource lets you create and manage [AWS Wisdom AIGuardrailVersions](https://docs.aws.amazon.com/wisdom/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-wisdom-aiguardrailversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const aiguardrailversion = await AWS.Wisdom.AIGuardrailVersion("aiguardrailversion-example", {
  AIGuardrailId: "example-aiguardrailid",
  AssistantId: "example-assistantid",
});
```

