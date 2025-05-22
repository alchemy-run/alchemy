---
title: Managing AWS SES MailManagerAddonSubscriptions with Alchemy
description: Learn how to create, update, and manage AWS SES MailManagerAddonSubscriptions using Alchemy Cloud Control.
---

# MailManagerAddonSubscription

The MailManagerAddonSubscription resource lets you create and manage [AWS SES MailManagerAddonSubscriptions](https://docs.aws.amazon.com/ses/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ses-mailmanageraddonsubscription.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const mailmanageraddonsubscription = await AWS.SES.MailManagerAddonSubscription(
  "mailmanageraddonsubscription-example",
  {
    AddonName: "mailmanageraddonsubscription-addon",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a mailmanageraddonsubscription with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMailManagerAddonSubscription = await AWS.SES.MailManagerAddonSubscription(
  "advanced-mailmanageraddonsubscription",
  {
    AddonName: "mailmanageraddonsubscription-addon",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

