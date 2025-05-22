---
title: Managing AWS DirectoryService SimpleADs with Alchemy
description: Learn how to create, update, and manage AWS DirectoryService SimpleADs using Alchemy Cloud Control.
---

# SimpleAD

The SimpleAD resource lets you create and manage [AWS DirectoryService SimpleADs](https://docs.aws.amazon.com/directoryservice/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-directoryservice-simplead.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const simplead = await AWS.DirectoryService.SimpleAD("simplead-example", {
  VpcSettings: "example-vpcsettings",
  Size: "example-size",
  Name: "simplead-",
  Description: "A simplead resource managed by Alchemy",
});
```

## Advanced Configuration

Create a simplead with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSimpleAD = await AWS.DirectoryService.SimpleAD("advanced-simplead", {
  VpcSettings: "example-vpcsettings",
  Size: "example-size",
  Name: "simplead-",
  Description: "A simplead resource managed by Alchemy",
});
```

