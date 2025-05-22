---
title: Managing AWS KMS ReplicaKeys with Alchemy
description: Learn how to create, update, and manage AWS KMS ReplicaKeys using Alchemy Cloud Control.
---

# ReplicaKey

The ReplicaKey resource lets you create and manage [AWS KMS ReplicaKeys](https://docs.aws.amazon.com/kms/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-kms-replicakey.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const replicakey = await AWS.KMS.ReplicaKey("replicakey-example", {
  KeyPolicy: {},
  PrimaryKeyArn: "example-primarykeyarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A replicakey resource managed by Alchemy",
});
```

## Advanced Configuration

Create a replicakey with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedReplicaKey = await AWS.KMS.ReplicaKey("advanced-replicakey", {
  KeyPolicy: {},
  PrimaryKeyArn: "example-primarykeyarn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A replicakey resource managed by Alchemy",
});
```

