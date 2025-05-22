---
title: Managing AWS NotificationsContacts EmailContacts with Alchemy
description: Learn how to create, update, and manage AWS NotificationsContacts EmailContacts using Alchemy Cloud Control.
---

# EmailContact

The EmailContact resource lets you create and manage [AWS NotificationsContacts EmailContacts](https://docs.aws.amazon.com/notificationscontacts/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-notificationscontacts-emailcontact.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const emailcontact = await AWS.NotificationsContacts.EmailContact("emailcontact-example", {
  EmailAddress: "example-emailaddress",
  Name: "emailcontact-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a emailcontact with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEmailContact = await AWS.NotificationsContacts.EmailContact("advanced-emailcontact", {
  EmailAddress: "example-emailaddress",
  Name: "emailcontact-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

