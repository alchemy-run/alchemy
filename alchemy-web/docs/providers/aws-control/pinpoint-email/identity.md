---
title: Managing AWS PinpointEmail Identitys with Alchemy
description: Learn how to create, update, and manage AWS PinpointEmail Identitys using Alchemy Cloud Control.
---

# Identity

The Identity resource lets you create and manage [AWS PinpointEmail Identitys](https://docs.aws.amazon.com/pinpointemail/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpointemail-identity.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const identity = await AWS.PinpointEmail.Identity("identity-example", {
  Name: "identity-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a identity with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedIdentity = await AWS.PinpointEmail.Identity("advanced-identity", {
  Name: "identity-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

