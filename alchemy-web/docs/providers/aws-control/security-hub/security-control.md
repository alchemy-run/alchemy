---
title: Managing AWS SecurityHub SecurityControls with Alchemy
description: Learn how to create, update, and manage AWS SecurityHub SecurityControls using Alchemy Cloud Control.
---

# SecurityControl

The SecurityControl resource lets you create and manage [AWS SecurityHub SecurityControls](https://docs.aws.amazon.com/securityhub/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-securityhub-securitycontrol.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const securitycontrol = await AWS.SecurityHub.SecurityControl("securitycontrol-example", {
  Parameters: {},
});
```

