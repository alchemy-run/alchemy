---
title: Managing AWS EC2 Volumes with Alchemy
description: Learn how to create, update, and manage AWS EC2 Volumes using Alchemy Cloud Control.
---

# Volume

The Volume resource lets you create and manage [AWS EC2 Volumes](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-volume.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const volume = await AWS.EC2.Volume("volume-example", {
  AvailabilityZone: "example-availabilityzone",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a volume with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedVolume = await AWS.EC2.Volume("advanced-volume", {
  AvailabilityZone: "example-availabilityzone",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

