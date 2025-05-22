---
title: Managing AWS IAM ServerCertificates with Alchemy
description: Learn how to create, update, and manage AWS IAM ServerCertificates using Alchemy Cloud Control.
---

# ServerCertificate

The ServerCertificate resource lets you create and manage [AWS IAM ServerCertificates](https://docs.aws.amazon.com/iam/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-servercertificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const servercertificate = await AWS.IAM.ServerCertificate("servercertificate-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a servercertificate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedServerCertificate = await AWS.IAM.ServerCertificate("advanced-servercertificate", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

