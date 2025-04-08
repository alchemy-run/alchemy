# Account Api Token

Creates and manages [Cloudflare API tokens](https://developers.cloudflare.com/api/tokens/) for authenticating with Cloudflare services.

# Minimal Example

Create a basic API token with read-only permissions:

```ts
import { AccountApiToken, PermissionGroups } from "alchemy/cloudflare";

// First, fetch all permission groups
const permissions = await PermissionGroups("cloudflare-permissions");

// Create a token with read-only permissions
const token = await AccountApiToken("readonly-token", {
  name: "Readonly Zone Token",
  policies: [
    {
      effect: "allow", 
      permissionGroups: [
        { id: permissions["Zone Read"].id },
        { id: permissions["Analytics Read"].id }
      ],
      resources: {
        "com.cloudflare.api.account.zone.*": "*"
      }
    }
  ]
});
```

# Create Token with Restrictions

Create a token with time and IP restrictions:

```ts
import { AccountApiToken, PermissionGroups } from "alchemy/cloudflare";

const permissions = await PermissionGroups("cloudflare-permissions");

const token = await AccountApiToken("restricted-token", {
  name: "Restricted Access Token",
  policies: [
    {
      effect: "allow",
      permissionGroups: [
        { id: permissions["Worker Routes Edit"].id }
      ],
      resources: {
        "com.cloudflare.api.account.worker.route.*": "*"
      }
    }
  ],
  notBefore: "2024-01-01T00:00:00Z",
  expiresOn: "2024-12-31T23:59:59Z",
  condition: {
    requestIp: {
      in: ["192.168.1.0/24", "10.0.0.0/8"],
      notIn: ["192.168.1.100/32"]
    }
  }
});
```