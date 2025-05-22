---
title: Managing AWS Events Archives with Alchemy
description: Learn how to create, update, and manage AWS Events Archives using Alchemy Cloud Control.
---

# Archive

The Archive resource lets you create and manage [AWS Events Archives](https://docs.aws.amazon.com/events/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-events-archive.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const archive = await AWS.Events.Archive("archive-example", {
  SourceArn: "example-sourcearn",
  Description: "A archive resource managed by Alchemy",
});
```

## Advanced Configuration

Create a archive with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedArchive = await AWS.Events.Archive("advanced-archive", {
  SourceArn: "example-sourcearn",
  Description: "A archive resource managed by Alchemy",
});
```

