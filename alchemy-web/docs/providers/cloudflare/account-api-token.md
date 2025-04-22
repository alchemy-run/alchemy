# AccountApiToken

Creates a [Cloudflare API Token](https://developers.cloudflare.com/api/tokens/) with specified permissions and restrictions.

# Minimal Example

Create a basic API token with read-only permissions:

```ts
import { AccountApiToken, PermissionGroups } from "alchemy/cloudflare";

// First, fetch all permission groups
const permissions = await PermissionGroups("cloudflare-permissions", {
  accountId: cfAccountId,
});

// Create a token with read-only permissions
const readOnlyToken = await AccountApiToken("readonly-token", {
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

# Create Token with IP Restrictions

Create a token with IP restrictions and time limits:

```ts
import { AccountApiToken } from "alchemy/cloudflare";

const restrictedToken = await AccountApiToken("restricted-token", {
  name: "Restricted Access Token",
  policies: [{
    effect: "allow",
    permissionGroups: [
      { id: permissions["Worker Routes Edit"].id }
    ],
    resources: {
      "com.cloudflare.api.account.worker.route.*": "*"
    }
  }],
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

# Create R2 Token

Create a token for R2 bucket access:

```ts
import { AccountApiToken } from "alchemy/cloudflare";

const r2Token = await AccountApiToken("r2-token", {
  name: "R2 Read-Only Token",
  policies: [{
    effect: "allow",
    resources: {
      "com.cloudflare.edge.r2.bucket.my-bucket": "*"
    },
    permissionGroups: [
      { id: permissions["Workers R2 Storage Bucket Item Read"].id }
    ]
  }]
});
```