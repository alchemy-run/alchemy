---
title: Managing AWS CloudFront RealtimeLogConfigs with Alchemy
description: Learn how to create, update, and manage AWS CloudFront RealtimeLogConfigs using Alchemy Cloud Control.
---

# RealtimeLogConfig

The RealtimeLogConfig resource lets you create and manage [AWS CloudFront RealtimeLogConfigs](https://docs.aws.amazon.com/cloudfront/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudfront-realtimelogconfig.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const realtimelogconfig = await AWS.CloudFront.RealtimeLogConfig("realtimelogconfig-example", {
  Fields: ["example-fields-1"],
  EndPoints: [],
  SamplingRate: 1,
  Name: "realtimelogconfig-",
});
```

