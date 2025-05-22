---
title: Managing AWS Wisdom AIAgentVersions with Alchemy
description: Learn how to create, update, and manage AWS Wisdom AIAgentVersions using Alchemy Cloud Control.
---

# AIAgentVersion

The AIAgentVersion resource lets you create and manage [AWS Wisdom AIAgentVersions](https://docs.aws.amazon.com/wisdom/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-wisdom-aiagentversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const aiagentversion = await AWS.Wisdom.AIAgentVersion("aiagentversion-example", {
  AssistantId: "example-assistantid",
  AIAgentId: "example-aiagentid",
});
```

