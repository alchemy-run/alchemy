---
title: Managing AWS SES ContactLists with Alchemy
description: Learn how to create, update, and manage AWS SES ContactLists using Alchemy Cloud Control.
---

# ContactList

The ContactList resource lets you create and manage [AWS SES ContactLists](https://docs.aws.amazon.com/ses/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ses-contactlist.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const contactlist = await AWS.SES.ContactList("contactlist-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A contactlist resource managed by Alchemy",
});
```

## Advanced Configuration

Create a contactlist with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedContactList = await AWS.SES.ContactList("advanced-contactlist", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A contactlist resource managed by Alchemy",
});
```

