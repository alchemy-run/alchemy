---
title: Managing AWS Connect EmailAddresss with Alchemy
description: Learn how to create, update, and manage AWS Connect EmailAddresss using Alchemy Cloud Control.
---

# EmailAddress

The EmailAddress resource lets you create and manage [AWS Connect EmailAddresss](https://docs.aws.amazon.com/connect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-connect-emailaddress.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const emailaddress = await AWS.Connect.EmailAddress("emailaddress-example", {
  InstanceArn: "example-instancearn",
  EmailAddress: "example-emailaddress",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A emailaddress resource managed by Alchemy",
});
```

## Advanced Configuration

Create a emailaddress with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEmailAddress = await AWS.Connect.EmailAddress("advanced-emailaddress", {
  InstanceArn: "example-instancearn",
  EmailAddress: "example-emailaddress",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A emailaddress resource managed by Alchemy",
});
```

