---
title: Managing AWS IoT CACertificates with Alchemy
description: Learn how to create, update, and manage AWS IoT CACertificates using Alchemy Cloud Control.
---

# CACertificate

The CACertificate resource lets you create and manage [AWS IoT CACertificates](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-cacertificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const cacertificate = await AWS.IoT.CACertificate("cacertificate-example", {
  Status: "example-status",
  CACertificatePem: "example-cacertificatepem",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a cacertificate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCACertificate = await AWS.IoT.CACertificate("advanced-cacertificate", {
  Status: "example-status",
  CACertificatePem: "example-cacertificatepem",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

