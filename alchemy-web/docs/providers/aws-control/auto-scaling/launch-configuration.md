---
title: Managing AWS AutoScaling LaunchConfigurations with Alchemy
description: Learn how to create, update, and manage AWS AutoScaling LaunchConfigurations using Alchemy Cloud Control.
---

# LaunchConfiguration

The LaunchConfiguration resource lets you create and manage [AWS AutoScaling LaunchConfigurations](https://docs.aws.amazon.com/autoscaling/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-autoscaling-launchconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const launchconfiguration = await AWS.AutoScaling.LaunchConfiguration(
  "launchconfiguration-example",
  { ImageId: "example-imageid", InstanceType: "example-instancetype" }
);
```

