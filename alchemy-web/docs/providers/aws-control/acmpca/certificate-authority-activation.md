---
title: Managing AWS ACMPCA CertificateAuthorityActivations with Alchemy
description: Learn how to create, update, and manage AWS ACMPCA CertificateAuthorityActivations using Alchemy Cloud Control.
---

# CertificateAuthorityActivation

The CertificateAuthorityActivation resource lets you create and manage [AWS ACMPCA CertificateAuthorityActivations](https://docs.aws.amazon.com/acmpca/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-acmpca-certificateauthorityactivation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const certificateauthorityactivation = await AWS.ACMPCA.CertificateAuthorityActivation(
  "certificateauthorityactivation-example",
  { CertificateAuthorityArn: "example-certificateauthorityarn", Certificate: "example-certificate" }
);
```

