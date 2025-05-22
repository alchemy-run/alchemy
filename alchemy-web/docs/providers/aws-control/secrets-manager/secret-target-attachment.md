---
title: Managing AWS SecretsManager SecretTargetAttachments with Alchemy
description: Learn how to create, update, and manage AWS SecretsManager SecretTargetAttachments using Alchemy Cloud Control.
---

# SecretTargetAttachment

The SecretTargetAttachment resource lets you create and manage [AWS SecretsManager SecretTargetAttachments](https://docs.aws.amazon.com/secretsmanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-secretsmanager-secrettargetattachment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const secrettargetattachment = await AWS.SecretsManager.SecretTargetAttachment(
  "secrettargetattachment-example",
  { SecretId: "example-secretid", TargetType: "example-targettype", TargetId: "example-targetid" }
);
```

