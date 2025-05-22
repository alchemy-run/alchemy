---
title: Managing AWS Organizations OrganizationalUnits with Alchemy
description: Learn how to create, update, and manage AWS Organizations OrganizationalUnits using Alchemy Cloud Control.
---

# OrganizationalUnit

The OrganizationalUnit resource lets you create and manage [AWS Organizations OrganizationalUnits](https://docs.aws.amazon.com/organizations/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-organizations-organizationalunit.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const organizationalunit = await AWS.Organizations.OrganizationalUnit(
  "organizationalunit-example",
  {
    ParentId: "example-parentid",
    Name: "organizationalunit-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a organizationalunit with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedOrganizationalUnit = await AWS.Organizations.OrganizationalUnit(
  "advanced-organizationalunit",
  {
    ParentId: "example-parentid",
    Name: "organizationalunit-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

