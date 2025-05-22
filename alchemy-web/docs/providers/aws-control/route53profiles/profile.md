---
title: Managing AWS Route53Profiles Profiles with Alchemy
description: Learn how to create, update, and manage AWS Route53Profiles Profiles using Alchemy Cloud Control.
---

# Profile

The Profile resource lets you create and manage [AWS Route53Profiles Profiles](https://docs.aws.amazon.com/route53profiles/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53profiles-profile.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const profile = await AWS.Route53Profiles.Profile("profile-example", {
  Name: "profile-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a profile with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedProfile = await AWS.Route53Profiles.Profile("advanced-profile", {
  Name: "profile-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

