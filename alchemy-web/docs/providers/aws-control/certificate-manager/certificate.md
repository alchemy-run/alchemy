---
title: Managing AWS CertificateManager Certificates with Alchemy
description: Learn how to create, update, and manage AWS CertificateManager Certificates using Alchemy Cloud Control.
---

# Certificate

The Certificate resource lets you create and manage [AWS CertificateManager Certificates](https://docs.aws.amazon.com/certificatemanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-certificatemanager-certificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const certificate = await AWS.CertificateManager.Certificate("certificate-example", {
  DomainName: "certificate-domain",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a certificate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCertificate = await AWS.CertificateManager.Certificate("advanced-certificate", {
  DomainName: "certificate-domain",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

