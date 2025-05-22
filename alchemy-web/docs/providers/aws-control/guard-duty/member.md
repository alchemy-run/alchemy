---
title: Managing AWS GuardDuty Members with Alchemy
description: Learn how to create, update, and manage AWS GuardDuty Members using Alchemy Cloud Control.
---

# Member

The Member resource lets you create and manage [AWS GuardDuty Members](https://docs.aws.amazon.com/guardduty/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-guardduty-member.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const member = await AWS.GuardDuty.Member("member-example", { Email: "example-email" });
```

