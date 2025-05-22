---
title: Managing AWS IoT SoftwarePackages with Alchemy
description: Learn how to create, update, and manage AWS IoT SoftwarePackages using Alchemy Cloud Control.
---

# SoftwarePackage

The SoftwarePackage resource lets you create and manage [AWS IoT SoftwarePackages](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-softwarepackage.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const softwarepackage = await AWS.IoT.SoftwarePackage("softwarepackage-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A softwarepackage resource managed by Alchemy",
});
```

## Advanced Configuration

Create a softwarepackage with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSoftwarePackage = await AWS.IoT.SoftwarePackage("advanced-softwarepackage", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A softwarepackage resource managed by Alchemy",
});
```

