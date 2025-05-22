---
title: Managing AWS OpsWorks Volumes with Alchemy
description: Learn how to create, update, and manage AWS OpsWorks Volumes using Alchemy Cloud Control.
---

# Volume

The Volume resource lets you create and manage [AWS OpsWorks Volumes](https://docs.aws.amazon.com/opsworks/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-opsworks-volume.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const volume = await AWS.OpsWorks.Volume("volume-example", {
  Ec2VolumeId: "example-ec2volumeid",
  StackId: "example-stackid",
});
```

