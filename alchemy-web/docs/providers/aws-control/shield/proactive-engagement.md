---
title: Managing AWS Shield ProactiveEngagements with Alchemy
description: Learn how to create, update, and manage AWS Shield ProactiveEngagements using Alchemy Cloud Control.
---

# ProactiveEngagement

The ProactiveEngagement resource lets you create and manage [AWS Shield ProactiveEngagements](https://docs.aws.amazon.com/shield/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-shield-proactiveengagement.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const proactiveengagement = await AWS.Shield.ProactiveEngagement("proactiveengagement-example", {
  ProactiveEngagementStatus: "example-proactiveengagementstatus",
  EmergencyContactList: [],
});
```

