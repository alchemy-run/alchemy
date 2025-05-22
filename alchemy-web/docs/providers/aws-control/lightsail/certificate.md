---
title: Managing AWS Lightsail Certificates with Alchemy
description: Learn how to create, update, and manage AWS Lightsail Certificates using Alchemy Cloud Control.
---

# Certificate

The Certificate resource lets you create and manage [AWS Lightsail Certificates](https://docs.aws.amazon.com/lightsail/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lightsail-certificate.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const certificate = await AWS.Lightsail.Certificate("certificate-example", {
  DomainName: "certificate-domain",
  CertificateName: "certificate-certificate",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a certificate with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCertificate = await AWS.Lightsail.Certificate("advanced-certificate", {
  DomainName: "certificate-domain",
  CertificateName: "certificate-certificate",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

