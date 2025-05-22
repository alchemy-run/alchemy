---
title: Managing AWS Pinpoint GCMChannels with Alchemy
description: Learn how to create, update, and manage AWS Pinpoint GCMChannels using Alchemy Cloud Control.
---

# GCMChannel

The GCMChannel resource lets you create and manage [AWS Pinpoint GCMChannels](https://docs.aws.amazon.com/pinpoint/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpoint-gcmchannel.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const gcmchannel = await AWS.Pinpoint.GCMChannel("gcmchannel-example", {
  ApplicationId: "example-applicationid",
});
```

