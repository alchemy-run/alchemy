---
title: Managing AWS MediaLive EventBridgeRuleTemplateGroups with Alchemy
description: Learn how to create, update, and manage AWS MediaLive EventBridgeRuleTemplateGroups using Alchemy Cloud Control.
---

# EventBridgeRuleTemplateGroup

The EventBridgeRuleTemplateGroup resource lets you create and manage [AWS MediaLive EventBridgeRuleTemplateGroups](https://docs.aws.amazon.com/medialive/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-medialive-eventbridgeruletemplategroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const eventbridgeruletemplategroup = await AWS.MediaLive.EventBridgeRuleTemplateGroup(
  "eventbridgeruletemplategroup-example",
  {
    Name: "eventbridgeruletemplategroup-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
    Description: "A eventbridgeruletemplategroup resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a eventbridgeruletemplategroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedEventBridgeRuleTemplateGroup = await AWS.MediaLive.EventBridgeRuleTemplateGroup(
  "advanced-eventbridgeruletemplategroup",
  {
    Name: "eventbridgeruletemplategroup-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A eventbridgeruletemplategroup resource managed by Alchemy",
  }
);
```

