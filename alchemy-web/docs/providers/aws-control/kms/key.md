---
title: Managing AWS KMS Keys with Alchemy
description: Learn how to create, update, and manage AWS KMS Keys using Alchemy Cloud Control.
---

# Key

The Key resource lets you create and manage [AWS KMS Keys](https://docs.aws.amazon.com/kms/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kms-key.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const key = await AWS.KMS.Key("key-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A key resource managed by Alchemy",
});
```

## Advanced Configuration

Create a key with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedKey = await AWS.KMS.Key("advanced-key", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A key resource managed by Alchemy",
});
```

