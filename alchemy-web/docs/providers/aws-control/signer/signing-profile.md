---
title: Managing AWS Signer SigningProfiles with Alchemy
description: Learn how to create, update, and manage AWS Signer SigningProfiles using Alchemy Cloud Control.
---

# SigningProfile

The SigningProfile resource lets you create and manage [AWS Signer SigningProfiles](https://docs.aws.amazon.com/signer/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-signer-signingprofile.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const signingprofile = await AWS.Signer.SigningProfile("signingprofile-example", {
  PlatformId: "example-platformid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a signingprofile with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSigningProfile = await AWS.Signer.SigningProfile("advanced-signingprofile", {
  PlatformId: "example-platformid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

