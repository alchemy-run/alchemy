---
title: Managing AWS Transfer Profiles with Alchemy
description: Learn how to create, update, and manage AWS Transfer Profiles using Alchemy Cloud Control.
---

# Profile

The Profile resource lets you create and manage [AWS Transfer Profiles](https://docs.aws.amazon.com/transfer/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-transfer-profile.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const profile = await AWS.Transfer.Profile("profile-example", {
  As2Id: "example-as2id",
  ProfileType: "example-profiletype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a profile with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedProfile = await AWS.Transfer.Profile("advanced-profile", {
  As2Id: "example-as2id",
  ProfileType: "example-profiletype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

