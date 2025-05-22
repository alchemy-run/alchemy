---
title: Managing AWS MemoryDB ACLs with Alchemy
description: Learn how to create, update, and manage AWS MemoryDB ACLs using Alchemy Cloud Control.
---

# ACL

The ACL resource lets you create and manage [AWS MemoryDB ACLs](https://docs.aws.amazon.com/memorydb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-memorydb-acl.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const acl = await AWS.MemoryDB.ACL("acl-example", {
  ACLName: "acl-acl",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a acl with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedACL = await AWS.MemoryDB.ACL("advanced-acl", {
  ACLName: "acl-acl",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

