---
title: Managing AWS IoT ResourceSpecificLoggings with Alchemy
description: Learn how to create, update, and manage AWS IoT ResourceSpecificLoggings using Alchemy Cloud Control.
---

# ResourceSpecificLogging

The ResourceSpecificLogging resource lets you create and manage [AWS IoT ResourceSpecificLoggings](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-resourcespecificlogging.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resourcespecificlogging = await AWS.IoT.ResourceSpecificLogging(
  "resourcespecificlogging-example",
  {
    TargetType: "example-targettype",
    TargetName: "resourcespecificlogging-target",
    LogLevel: "example-loglevel",
  }
);
```

