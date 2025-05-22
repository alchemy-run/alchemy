---
title: Managing AWS SupportApp SlackWorkspaceConfigurations with Alchemy
description: Learn how to create, update, and manage AWS SupportApp SlackWorkspaceConfigurations using Alchemy Cloud Control.
---

# SlackWorkspaceConfiguration

The SlackWorkspaceConfiguration resource lets you create and manage [AWS SupportApp SlackWorkspaceConfigurations](https://docs.aws.amazon.com/supportapp/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-supportapp-slackworkspaceconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const slackworkspaceconfiguration = await AWS.SupportApp.SlackWorkspaceConfiguration(
  "slackworkspaceconfiguration-example",
  { TeamId: "example-teamid" }
);
```

