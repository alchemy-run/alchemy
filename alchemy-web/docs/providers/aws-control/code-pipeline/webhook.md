---
title: Managing AWS CodePipeline Webhooks with Alchemy
description: Learn how to create, update, and manage AWS CodePipeline Webhooks using Alchemy Cloud Control.
---

# Webhook

The Webhook resource lets you create and manage [AWS CodePipeline Webhooks](https://docs.aws.amazon.com/codepipeline/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codepipeline-webhook.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const webhook = await AWS.CodePipeline.Webhook("webhook-example", {
  AuthenticationConfiguration: "example-authenticationconfiguration",
  Filters: [],
  Authentication: "example-authentication",
  TargetPipeline: "example-targetpipeline",
  TargetAction: "example-targetaction",
  TargetPipelineVersion: 1,
});
```

