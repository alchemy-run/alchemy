---
title: Managing AWS Events Rules with Alchemy
description: Learn how to create, update, and manage AWS Events Rules using Alchemy Cloud Control.
---

# Rule

The Rule resource lets you create and manage [AWS Events Rules](https://docs.aws.amazon.com/events/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-events-rule.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const rule = await AWS.Events.Rule("rule-example", {
  Description: "A rule resource managed by Alchemy",
});
```

## Advanced Configuration

Create a rule with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRule = await AWS.Events.Rule("advanced-rule", {
  Description: "A rule resource managed by Alchemy",
});
```

