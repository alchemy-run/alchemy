---
title: Managing AWS Pinpoint APNSVoipChannels with Alchemy
description: Learn how to create, update, and manage AWS Pinpoint APNSVoipChannels using Alchemy Cloud Control.
---

# APNSVoipChannel

The APNSVoipChannel resource lets you create and manage [AWS Pinpoint APNSVoipChannels](https://docs.aws.amazon.com/pinpoint/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpoint-apnsvoipchannel.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const apnsvoipchannel = await AWS.Pinpoint.APNSVoipChannel("apnsvoipchannel-example", {
  ApplicationId: "example-applicationid",
});
```

