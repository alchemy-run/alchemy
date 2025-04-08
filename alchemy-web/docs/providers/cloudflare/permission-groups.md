# Permission Groups

Lists all [Cloudflare API permission groups](https://developers.cloudflare.com/api/tokens/create/permissions/) available for an account. Used when creating API tokens to grant specific permissions.

# Minimal Example

Get all available permission groups for an account:

```ts
import { PermissionGroups } from "alchemy/cloudflare";

const permissions = await PermissionGroups("cloudflare-permissions");
```

# Create API Token with Permissions

Use permission groups to create an API token with specific access:

```ts
import { AccountApiToken, PermissionGroups } from "alchemy/cloudflare";

const permissions = await PermissionGroups("cloudflare-permissions");

const token = await AccountApiToken("r2-token", {
  name: "R2 Read-Only Token",
  policies: [{
    effect: "allow", 
    resources: {
      "com.cloudflare.edge.r2.bucket.abc123_default_my-bucket": "*"
    },
    permissionGroups: [{
      id: permissions["Workers R2 Storage Bucket Item Read"].id
    }]
  }]
});
```