---
title: Managing AWS Connect PhoneNumbers with Alchemy
description: Learn how to create, update, and manage AWS Connect PhoneNumbers using Alchemy Cloud Control.
---

# PhoneNumber

The PhoneNumber resource lets you create and manage [AWS Connect PhoneNumbers](https://docs.aws.amazon.com/connect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-connect-phonenumber.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const phonenumber = await AWS.Connect.PhoneNumber("phonenumber-example", {
  TargetArn: "example-targetarn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A phonenumber resource managed by Alchemy",
});
```

## Advanced Configuration

Create a phonenumber with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPhoneNumber = await AWS.Connect.PhoneNumber("advanced-phonenumber", {
  TargetArn: "example-targetarn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A phonenumber resource managed by Alchemy",
});
```

