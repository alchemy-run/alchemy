---
title: Managing AWS Neptune EventSubscriptions with Alchemy
description: Learn how to create, update, and manage AWS Neptune EventSubscriptions using Alchemy Cloud Control.
---

# EventSubscription

The EventSubscription resource lets you create and manage [AWS Neptune EventSubscriptions](https://docs.aws.amazon.com/neptune/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-neptune-eventsubscription.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eventsubscription = await AWS.Neptune.EventSubscription("eventsubscription-example", {});
```

