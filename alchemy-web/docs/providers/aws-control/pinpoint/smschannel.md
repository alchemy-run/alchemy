---
title: Managing AWS Pinpoint SMSChannels with Alchemy
description: Learn how to create, update, and manage AWS Pinpoint SMSChannels using Alchemy Cloud Control.
---

# SMSChannel

The SMSChannel resource lets you create and manage [AWS Pinpoint SMSChannels](https://docs.aws.amazon.com/pinpoint/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpoint-smschannel.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const smschannel = await AWS.Pinpoint.SMSChannel("smschannel-example", {
  ApplicationId: "example-applicationid",
});
```

