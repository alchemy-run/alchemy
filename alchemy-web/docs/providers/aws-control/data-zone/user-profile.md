---
title: Managing AWS DataZone UserProfiles with Alchemy
description: Learn how to create, update, and manage AWS DataZone UserProfiles using Alchemy Cloud Control.
---

# UserProfile

The UserProfile resource lets you create and manage [AWS DataZone UserProfiles](https://docs.aws.amazon.com/datazone/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-datazone-userprofile.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const userprofile = await AWS.DataZone.UserProfile("userprofile-example", {
  UserIdentifier: "example-useridentifier",
  DomainIdentifier: "example-domainidentifier",
});
```

