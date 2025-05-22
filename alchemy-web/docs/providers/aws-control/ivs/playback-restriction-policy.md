---
title: Managing AWS IVS PlaybackRestrictionPolicys with Alchemy
description: Learn how to create, update, and manage AWS IVS PlaybackRestrictionPolicys using Alchemy Cloud Control.
---

# PlaybackRestrictionPolicy

The PlaybackRestrictionPolicy resource lets you create and manage [AWS IVS PlaybackRestrictionPolicys](https://docs.aws.amazon.com/ivs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ivs-playbackrestrictionpolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const playbackrestrictionpolicy = await AWS.IVS.PlaybackRestrictionPolicy(
  "playbackrestrictionpolicy-example",
  {
    AllowedOrigins: ["example-allowedorigins-1"],
    AllowedCountries: ["example-allowedcountries-1"],
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a playbackrestrictionpolicy with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPlaybackRestrictionPolicy = await AWS.IVS.PlaybackRestrictionPolicy(
  "advanced-playbackrestrictionpolicy",
  {
    AllowedOrigins: ["example-allowedorigins-1"],
    AllowedCountries: ["example-allowedcountries-1"],
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

