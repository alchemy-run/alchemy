---
title: Managing AWS SecurityHub DelegatedAdmins with Alchemy
description: Learn how to create, update, and manage AWS SecurityHub DelegatedAdmins using Alchemy Cloud Control.
---

# DelegatedAdmin

The DelegatedAdmin resource lets you create and manage [AWS SecurityHub DelegatedAdmins](https://docs.aws.amazon.com/securityhub/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-securityhub-delegatedadmin.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const delegatedadmin = await AWS.SecurityHub.DelegatedAdmin("delegatedadmin-example", {
  AdminAccountId: "example-adminaccountid",
});
```

