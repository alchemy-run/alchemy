---
title: Managing AWS ApplicationSignals Discoverys with Alchemy
description: Learn how to create, update, and manage AWS ApplicationSignals Discoverys using Alchemy Cloud Control.
---

# Discovery

The Discovery resource lets you create and manage [AWS ApplicationSignals Discoverys](https://docs.aws.amazon.com/applicationsignals/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-applicationsignals-discovery.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const discovery = await AWS.ApplicationSignals.Discovery("discovery-example", {});
```

