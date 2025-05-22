---
title: Managing AWS Greengrass GroupVersions with Alchemy
description: Learn how to create, update, and manage AWS Greengrass GroupVersions using Alchemy Cloud Control.
---

# GroupVersion

The GroupVersion resource lets you create and manage [AWS Greengrass GroupVersions](https://docs.aws.amazon.com/greengrass/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-greengrass-groupversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const groupversion = await AWS.Greengrass.GroupVersion("groupversion-example", {
  GroupId: "example-groupid",
});
```

