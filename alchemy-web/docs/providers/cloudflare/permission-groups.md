# PermissionGroups

Lists all [Cloudflare API permission groups](https://developers.cloudflare.com/api/tokens/create/permissions/) available for your account. Used when creating API tokens with specific permissions.

# Minimal Example

Get all available permission groups:

```ts
import { PermissionGroups } from "alchemy/cloudflare";

const permissions = await PermissionGroups("cloudflare-permissions", {
  accountId: "abc123" // Optional - will auto-discover if not provided
});
```

# Use with AccountApiToken

Create an API token with specific permissions:

```ts
import { PermissionGroups, AccountApiToken } from "alchemy/cloudflare";

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