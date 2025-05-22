---
title: Managing AWS Config OrganizationConformancePacks with Alchemy
description: Learn how to create, update, and manage AWS Config OrganizationConformancePacks using Alchemy Cloud Control.
---

# OrganizationConformancePack

The OrganizationConformancePack resource lets you create and manage [AWS Config OrganizationConformancePacks](https://docs.aws.amazon.com/config/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-config-organizationconformancepack.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const organizationconformancepack = await AWS.Config.OrganizationConformancePack(
  "organizationconformancepack-example",
  { OrganizationConformancePackName: "organizationconformancepack-organizationconformancepack" }
);
```

