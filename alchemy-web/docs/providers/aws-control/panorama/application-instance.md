---
title: Managing AWS Panorama ApplicationInstances with Alchemy
description: Learn how to create, update, and manage AWS Panorama ApplicationInstances using Alchemy Cloud Control.
---

# ApplicationInstance

The ApplicationInstance resource lets you create and manage [AWS Panorama ApplicationInstances](https://docs.aws.amazon.com/panorama/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-panorama-applicationinstance.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const applicationinstance = await AWS.Panorama.ApplicationInstance("applicationinstance-example", {
  DefaultRuntimeContextDevice: "example-defaultruntimecontextdevice",
  ManifestPayload: "example-manifestpayload",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A applicationinstance resource managed by Alchemy",
});
```

## Advanced Configuration

Create a applicationinstance with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedApplicationInstance = await AWS.Panorama.ApplicationInstance(
  "advanced-applicationinstance",
  {
    DefaultRuntimeContextDevice: "example-defaultruntimecontextdevice",
    ManifestPayload: "example-manifestpayload",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A applicationinstance resource managed by Alchemy",
  }
);
```

