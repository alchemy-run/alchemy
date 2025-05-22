---
title: Managing AWS Pinpoint APNSSandboxChannels with Alchemy
description: Learn how to create, update, and manage AWS Pinpoint APNSSandboxChannels using Alchemy Cloud Control.
---

# APNSSandboxChannel

The APNSSandboxChannel resource lets you create and manage [AWS Pinpoint APNSSandboxChannels](https://docs.aws.amazon.com/pinpoint/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpoint-apnssandboxchannel.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const apnssandboxchannel = await AWS.Pinpoint.APNSSandboxChannel("apnssandboxchannel-example", {
  ApplicationId: "example-applicationid",
});
```

