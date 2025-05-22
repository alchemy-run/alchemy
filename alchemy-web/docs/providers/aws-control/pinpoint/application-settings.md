---
title: Managing AWS Pinpoint ApplicationSettingss with Alchemy
description: Learn how to create, update, and manage AWS Pinpoint ApplicationSettingss using Alchemy Cloud Control.
---

# ApplicationSettings

The ApplicationSettings resource lets you create and manage [AWS Pinpoint ApplicationSettingss](https://docs.aws.amazon.com/pinpoint/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-pinpoint-applicationsettings.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const applicationsettings = await AWS.Pinpoint.ApplicationSettings("applicationsettings-example", {
  ApplicationId: "example-applicationid",
});
```

