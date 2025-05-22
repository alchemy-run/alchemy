---
title: Managing AWS SES MailManagerAddonInstances with Alchemy
description: Learn how to create, update, and manage AWS SES MailManagerAddonInstances using Alchemy Cloud Control.
---

# MailManagerAddonInstance

The MailManagerAddonInstance resource lets you create and manage [AWS SES MailManagerAddonInstances](https://docs.aws.amazon.com/ses/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ses-mailmanageraddoninstance.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const mailmanageraddoninstance = await AWS.SES.MailManagerAddonInstance(
  "mailmanageraddoninstance-example",
  {
    AddonSubscriptionId: "example-addonsubscriptionid",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a mailmanageraddoninstance with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedMailManagerAddonInstance = await AWS.SES.MailManagerAddonInstance(
  "advanced-mailmanageraddoninstance",
  {
    AddonSubscriptionId: "example-addonsubscriptionid",
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

