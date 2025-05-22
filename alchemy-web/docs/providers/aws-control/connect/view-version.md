---
title: Managing AWS Connect ViewVersions with Alchemy
description: Learn how to create, update, and manage AWS Connect ViewVersions using Alchemy Cloud Control.
---

# ViewVersion

The ViewVersion resource lets you create and manage [AWS Connect ViewVersions](https://docs.aws.amazon.com/connect/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-connect-viewversion.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const viewversion = await AWS.Connect.ViewVersion("viewversion-example", {
  ViewArn: "example-viewarn",
});
```

