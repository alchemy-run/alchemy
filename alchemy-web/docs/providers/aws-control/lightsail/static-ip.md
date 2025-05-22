---
title: Managing AWS Lightsail StaticIps with Alchemy
description: Learn how to create, update, and manage AWS Lightsail StaticIps using Alchemy Cloud Control.
---

# StaticIp

The StaticIp resource lets you create and manage [AWS Lightsail StaticIps](https://docs.aws.amazon.com/lightsail/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lightsail-staticip.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const staticip = await AWS.Lightsail.StaticIp("staticip-example", {
  StaticIpName: "staticip-staticip",
});
```

