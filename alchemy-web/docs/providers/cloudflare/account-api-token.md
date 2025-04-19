# AccountApiToken

Create and manage [Cloudflare API tokens](https://developers.cloudflare.com/api/tokens/) with specific permissions and access controls.

# Minimal Example

Create a basic API token with read-only permissions.

```ts
import { AccountApiToken, PermissionGroups } from "alchemy/cloudflare";

// First, fetch all permission groups
const permissions = await PermissionGroups("cloudflare-permissions");

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
        "com.cloudflare.api.account.zone.22b1de5f1c0e4b3ea97bb1e963b06a43": "*"
      }
    }
  ]
});
```

# Token with Time and IP Restrictions

Create a token with time-based and IP-based access restrictions.

```ts
import { AccountApiToken, PermissionGroups } from "alchemy/cloudflare";

const permissions = await PermissionGroups("cloudflare-permissions");

const restrictedToken = await AccountApiToken("restricted-token", {
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
  notBefore: "2023-01-01T00:00:00Z",
  expiresOn: "2023-12-31T23:59:59Z",
  condition: {
    requestIp: {
      in: ["192.168.1.0/24", "10.0.0.0/8"],
      notIn: ["192.168.1.100/32"]
    }
  }
});
```

# Bind to a Worker

Use the token in a Cloudflare Worker.

```ts
import { Worker, AccountApiToken } from "alchemy/cloudflare";

const token = await AccountApiToken("api-token", {
  name: "Worker API Token",
  policies: [
    {
      effect: "allow",
      permissionGroups: [
        { id: permissions["Zone Read"].id }
      ],
      resources: {
        "com.cloudflare.api.account.zone.*": "*"
      }
    }
  ]
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    API_TOKEN: token.value
  }
});
```