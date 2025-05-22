---
title: Managing AWS IoT ThingPrincipalAttachments with Alchemy
description: Learn how to create, update, and manage AWS IoT ThingPrincipalAttachments using Alchemy Cloud Control.
---

# ThingPrincipalAttachment

The ThingPrincipalAttachment resource lets you create and manage [AWS IoT ThingPrincipalAttachments](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-thingprincipalattachment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const thingprincipalattachment = await AWS.IoT.ThingPrincipalAttachment(
  "thingprincipalattachment-example",
  { Principal: "example-principal", ThingName: "thingprincipalattachment-thing" }
);
```

