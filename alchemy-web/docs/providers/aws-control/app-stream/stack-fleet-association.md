---
title: Managing AWS AppStream StackFleetAssociations with Alchemy
description: Learn how to create, update, and manage AWS AppStream StackFleetAssociations using Alchemy Cloud Control.
---

# StackFleetAssociation

The StackFleetAssociation resource lets you create and manage [AWS AppStream StackFleetAssociations](https://docs.aws.amazon.com/appstream/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appstream-stackfleetassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const stackfleetassociation = await AWS.AppStream.StackFleetAssociation(
  "stackfleetassociation-example",
  { FleetName: "stackfleetassociation-fleet", StackName: "stackfleetassociation-stack" }
);
```

