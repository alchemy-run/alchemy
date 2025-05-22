---
title: Managing AWS Route53Profiles ProfileAssociations with Alchemy
description: Learn how to create, update, and manage AWS Route53Profiles ProfileAssociations using Alchemy Cloud Control.
---

# ProfileAssociation

The ProfileAssociation resource lets you create and manage [AWS Route53Profiles ProfileAssociations](https://docs.aws.amazon.com/route53profiles/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53profiles-profileassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const profileassociation = await AWS.Route53Profiles.ProfileAssociation(
  "profileassociation-example",
  {
    ProfileId: "example-profileid",
    ResourceId: "example-resourceid",
    Name: "profileassociation-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a profileassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedProfileAssociation = await AWS.Route53Profiles.ProfileAssociation(
  "advanced-profileassociation",
  {
    ProfileId: "example-profileid",
    ResourceId: "example-resourceid",
    Name: "profileassociation-",
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

