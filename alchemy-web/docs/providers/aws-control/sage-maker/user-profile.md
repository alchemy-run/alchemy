---
title: Managing AWS SageMaker UserProfiles with Alchemy
description: Learn how to create, update, and manage AWS SageMaker UserProfiles using Alchemy Cloud Control.
---

# UserProfile

The UserProfile resource lets you create and manage [AWS SageMaker UserProfiles](https://docs.aws.amazon.com/sagemaker/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-sagemaker-userprofile.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const userprofile = await AWS.SageMaker.UserProfile("userprofile-example", {
  DomainId: "example-domainid",
  UserProfileName: "userprofile-userprofile",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a userprofile with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedUserProfile = await AWS.SageMaker.UserProfile("advanced-userprofile", {
  DomainId: "example-domainid",
  UserProfileName: "userprofile-userprofile",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

