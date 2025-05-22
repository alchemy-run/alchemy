---
title: Managing AWS Detective MemberInvitations with Alchemy
description: Learn how to create, update, and manage AWS Detective MemberInvitations using Alchemy Cloud Control.
---

# MemberInvitation

The MemberInvitation resource lets you create and manage [AWS Detective MemberInvitations](https://docs.aws.amazon.com/detective/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-detective-memberinvitation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const memberinvitation = await AWS.Detective.MemberInvitation("memberinvitation-example", {
  MemberId: "example-memberid",
  GraphArn: "example-grapharn",
  MemberEmailAddress: "example-memberemailaddress",
});
```

