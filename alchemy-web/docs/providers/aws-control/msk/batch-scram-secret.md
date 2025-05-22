---
title: Managing AWS MSK BatchScramSecrets with Alchemy
description: Learn how to create, update, and manage AWS MSK BatchScramSecrets using Alchemy Cloud Control.
---

# BatchScramSecret

The BatchScramSecret resource lets you create and manage [AWS MSK BatchScramSecrets](https://docs.aws.amazon.com/msk/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-msk-batchscramsecret.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const batchscramsecret = await AWS.MSK.BatchScramSecret("batchscramsecret-example", {
  ClusterArn: "example-clusterarn",
});
```

