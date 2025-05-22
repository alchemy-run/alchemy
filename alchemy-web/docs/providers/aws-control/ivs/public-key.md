---
title: Managing AWS IVS PublicKeys with Alchemy
description: Learn how to create, update, and manage AWS IVS PublicKeys using Alchemy Cloud Control.
---

# PublicKey

The PublicKey resource lets you create and manage [AWS IVS PublicKeys](https://docs.aws.amazon.com/ivs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ivs-publickey.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const publickey = await AWS.IVS.PublicKey("publickey-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a publickey with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPublicKey = await AWS.IVS.PublicKey("advanced-publickey", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

