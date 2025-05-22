---
title: Managing AWS IoT PolicyPrincipalAttachments with Alchemy
description: Learn how to create, update, and manage AWS IoT PolicyPrincipalAttachments using Alchemy Cloud Control.
---

# PolicyPrincipalAttachment

The PolicyPrincipalAttachment resource lets you create and manage [AWS IoT PolicyPrincipalAttachments](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-policyprincipalattachment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const policyprincipalattachment = await AWS.IoT.PolicyPrincipalAttachment(
  "policyprincipalattachment-example",
  { PolicyName: "policyprincipalattachment-policy", Principal: "example-principal" }
);
```

