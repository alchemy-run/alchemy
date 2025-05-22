---
title: Managing AWS DirectoryService MicrosoftADs with Alchemy
description: Learn how to create, update, and manage AWS DirectoryService MicrosoftADs using Alchemy Cloud Control.
---

# MicrosoftAD

The MicrosoftAD resource lets you create and manage [AWS DirectoryService MicrosoftADs](https://docs.aws.amazon.com/directoryservice/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-directoryservice-microsoftad.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const microsoftad = await AWS.DirectoryService.MicrosoftAD("microsoftad-example", {
  Name: "microsoftad-",
  Password: "example-password",
  VpcSettings: "example-vpcsettings",
});
```

