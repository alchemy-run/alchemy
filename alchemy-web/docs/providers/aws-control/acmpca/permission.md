---
title: Managing AWS ACMPCA Permissions with Alchemy
description: Learn how to create, update, and manage AWS ACMPCA Permissions using Alchemy Cloud Control.
---

# Permission

The Permission resource lets you create and manage [AWS ACMPCA Permissions](https://docs.aws.amazon.com/acmpca/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-acmpca-permission.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const permission = await AWS.ACMPCA.Permission("permission-example", {
  CertificateAuthorityArn: "example-certificateauthorityarn",
  Actions: ["example-actions-1"],
  Principal: "example-principal",
});
```

