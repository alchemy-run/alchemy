---
title: Managing AWS ResourceGroups TagSyncTasks with Alchemy
description: Learn how to create, update, and manage AWS ResourceGroups TagSyncTasks using Alchemy Cloud Control.
---

# TagSyncTask

The TagSyncTask resource lets you create and manage [AWS ResourceGroups TagSyncTasks](https://docs.aws.amazon.com/resourcegroups/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-resourcegroups-tagsynctask.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const tagsynctask = await AWS.ResourceGroups.TagSyncTask("tagsynctask-example", {
  Group: "example-group",
  TagKey: "example-tagkey",
  TagValue: "example-tagvalue",
  RoleArn: "example-rolearn",
});
```

