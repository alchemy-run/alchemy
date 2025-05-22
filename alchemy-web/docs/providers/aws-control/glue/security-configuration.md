---
title: Managing AWS Glue SecurityConfigurations with Alchemy
description: Learn how to create, update, and manage AWS Glue SecurityConfigurations using Alchemy Cloud Control.
---

# SecurityConfiguration

The SecurityConfiguration resource lets you create and manage [AWS Glue SecurityConfigurations](https://docs.aws.amazon.com/glue/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-glue-securityconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const securityconfiguration = await AWS.Glue.SecurityConfiguration(
  "securityconfiguration-example",
  { EncryptionConfiguration: "example-encryptionconfiguration", Name: "securityconfiguration-" }
);
```

