---
title: Managing AWS Logs LogStreams with Alchemy
description: Learn how to create, update, and manage AWS Logs LogStreams using Alchemy Cloud Control.
---

# LogStream

The LogStream resource lets you create and manage [AWS Logs LogStreams](https://docs.aws.amazon.com/logs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-logstream.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const logstream = await AWS.Logs.LogStream("logstream-example", {
  LogGroupName: "logstream-loggroup",
});
```

