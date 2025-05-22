---
title: Managing AWS Config DeliveryChannels with Alchemy
description: Learn how to create, update, and manage AWS Config DeliveryChannels using Alchemy Cloud Control.
---

# DeliveryChannel

The DeliveryChannel resource lets you create and manage [AWS Config DeliveryChannels](https://docs.aws.amazon.com/config/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-config-deliverychannel.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const deliverychannel = await AWS.Config.DeliveryChannel("deliverychannel-example", {
  S3BucketName: "deliverychannel-s3bucket",
});
```

