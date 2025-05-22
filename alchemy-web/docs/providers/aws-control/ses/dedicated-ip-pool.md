---
title: Managing AWS SES DedicatedIpPools with Alchemy
description: Learn how to create, update, and manage AWS SES DedicatedIpPools using Alchemy Cloud Control.
---

# DedicatedIpPool

The DedicatedIpPool resource lets you create and manage [AWS SES DedicatedIpPools](https://docs.aws.amazon.com/ses/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ses-dedicatedippool.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const dedicatedippool = await AWS.SES.DedicatedIpPool("dedicatedippool-example", {});
```

