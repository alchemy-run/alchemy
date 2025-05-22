---
title: Managing AWS Detective OrganizationAdmins with Alchemy
description: Learn how to create, update, and manage AWS Detective OrganizationAdmins using Alchemy Cloud Control.
---

# OrganizationAdmin

The OrganizationAdmin resource lets you create and manage [AWS Detective OrganizationAdmins](https://docs.aws.amazon.com/detective/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-detective-organizationadmin.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const organizationadmin = await AWS.Detective.OrganizationAdmin("organizationadmin-example", {
  AccountId: "example-accountid",
});
```

