---
title: Managing AWS EFS AccessPoints with Alchemy
description: Learn how to create, update, and manage AWS EFS AccessPoints using Alchemy Cloud Control.
---

# AccessPoint

The AccessPoint resource lets you create and manage [AWS EFS AccessPoints](https://docs.aws.amazon.com/efs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-efs-accesspoint.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const accesspoint = await AWS.EFS.AccessPoint("accesspoint-example", {
  FileSystemId: "example-filesystemid",
});
```

