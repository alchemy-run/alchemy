---
title: Managing AWS CodeStarNotifications NotificationRules with Alchemy
description: Learn how to create, update, and manage AWS CodeStarNotifications NotificationRules using Alchemy Cloud Control.
---

# NotificationRule

The NotificationRule resource lets you create and manage [AWS CodeStarNotifications NotificationRules](https://docs.aws.amazon.com/codestarnotifications/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-codestarnotifications-notificationrule.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const notificationrule = await AWS.CodeStarNotifications.NotificationRule(
  "notificationrule-example",
  {
    EventTypeIds: ["example-eventtypeids-1"],
    DetailType: "example-detailtype",
    Resource: "example-resource",
    Targets: [],
    Name: "notificationrule-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a notificationrule with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedNotificationRule = await AWS.CodeStarNotifications.NotificationRule(
  "advanced-notificationrule",
  {
    EventTypeIds: ["example-eventtypeids-1"],
    DetailType: "example-detailtype",
    Resource: "example-resource",
    Targets: [],
    Name: "notificationrule-",
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

