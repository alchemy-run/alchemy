---
title: Managing AWS LicenseManager Grants with Alchemy
description: Learn how to create, update, and manage AWS LicenseManager Grants using Alchemy Cloud Control.
---

# Grant

The Grant resource lets you create and manage [AWS LicenseManager Grants](https://docs.aws.amazon.com/licensemanager/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-licensemanager-grant.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const grant = await AWS.LicenseManager.Grant("grant-example", {});
```

