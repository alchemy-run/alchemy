---
title: Managing AWS Transfer Certificates with Alchemy
description: Learn how to create, update, and manage AWS Transfer Certificates using Alchemy Cloud Control.
---

# Certificate

The Certificate resource lets you create and manage [AWS Transfer Certificates](https://docs.aws.amazon.com/transfer/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-transfer-certificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const certificate = await AWS.Transfer.Certificate("certificate-example", {
  Usage: "example-usage",
  Certificate: "example-certificate",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A certificate resource managed by Alchemy",
});
```

## Advanced Configuration

Create a certificate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCertificate = await AWS.Transfer.Certificate("advanced-certificate", {
  Usage: "example-usage",
  Certificate: "example-certificate",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A certificate resource managed by Alchemy",
});
```

