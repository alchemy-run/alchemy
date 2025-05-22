---
title: Managing AWS DocDB EventSubscriptions with Alchemy
description: Learn how to create, update, and manage AWS DocDB EventSubscriptions using Alchemy Cloud Control.
---

# EventSubscription

The EventSubscription resource lets you create and manage [AWS DocDB EventSubscriptions](https://docs.aws.amazon.com/docdb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-docdb-eventsubscription.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eventsubscription = await AWS.DocDB.EventSubscription("eventsubscription-example", {
  SnsTopicArn: "example-snstopicarn",
});
```

