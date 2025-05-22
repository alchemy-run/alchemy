---
title: Managing AWS SupportApp SlackChannelConfigurations with Alchemy
description: Learn how to create, update, and manage AWS SupportApp SlackChannelConfigurations using Alchemy Cloud Control.
---

# SlackChannelConfiguration

The SlackChannelConfiguration resource lets you create and manage [AWS SupportApp SlackChannelConfigurations](https://docs.aws.amazon.com/supportapp/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-supportapp-slackchannelconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const slackchannelconfiguration = await AWS.SupportApp.SlackChannelConfiguration(
  "slackchannelconfiguration-example",
  {
    ChannelRoleArn: "example-channelrolearn",
    NotifyOnCaseSeverity: "example-notifyoncaseseverity",
    TeamId: "example-teamid",
    ChannelId: "example-channelid",
  }
);
```

