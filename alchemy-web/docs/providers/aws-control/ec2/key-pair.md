---
title: Managing AWS EC2 KeyPairs with Alchemy
description: Learn how to create, update, and manage AWS EC2 KeyPairs using Alchemy Cloud Control.
---

# KeyPair

The KeyPair resource lets you create and manage [AWS EC2 KeyPairs](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-keypair.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const keypair = await AWS.EC2.KeyPair("keypair-example", {
  KeyName: "keypair-key",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a keypair with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedKeyPair = await AWS.EC2.KeyPair("advanced-keypair", {
  KeyName: "keypair-key",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

