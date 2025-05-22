---
title: Managing AWS Organizations Accounts with Alchemy
description: Learn how to create, update, and manage AWS Organizations Accounts using Alchemy Cloud Control.
---

# Account

The Account resource lets you create and manage [AWS Organizations Accounts](https://docs.aws.amazon.com/organizations/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-organizations-account.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const account = await AWS.Organizations.Account("account-example", {
  Email: "example-email",
  AccountName: "account-account",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a account with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAccount = await AWS.Organizations.Account("advanced-account", {
  Email: "example-email",
  AccountName: "account-account",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

