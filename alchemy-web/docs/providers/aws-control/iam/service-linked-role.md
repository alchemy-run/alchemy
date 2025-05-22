---
title: Managing AWS IAM ServiceLinkedRoles with Alchemy
description: Learn how to create, update, and manage AWS IAM ServiceLinkedRoles using Alchemy Cloud Control.
---

# ServiceLinkedRole

The ServiceLinkedRole resource lets you create and manage [AWS IAM ServiceLinkedRoles](https://docs.aws.amazon.com/iam/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-servicelinkedrole.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const servicelinkedrole = await AWS.IAM.ServiceLinkedRole("servicelinkedrole-example", {
  Description: "A servicelinkedrole resource managed by Alchemy",
});
```

## Advanced Configuration

Create a servicelinkedrole with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedServiceLinkedRole = await AWS.IAM.ServiceLinkedRole("advanced-servicelinkedrole", {
  Description: "A servicelinkedrole resource managed by Alchemy",
});
```

