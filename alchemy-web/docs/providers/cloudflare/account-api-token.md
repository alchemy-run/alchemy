# AccountApiToken

The AccountApiToken resource creates a [Cloudflare API Token](https://developers.cloudflare.com/api/tokens/) with specified permissions and access policies.

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

Create a token with IP address restrictions for enhanced security:

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
  condition: {
    requestIp: {
      in: ["192.168.1.0/24", "10.0.0.0/8"],
      notIn: ["192.168.1.100/32"]
    }
  }
});
```

# Create Token with Time Restrictions

Create a token that is only valid for a specific time period:

```ts
import { AccountApiToken } from "alchemy/cloudflare";

const timedToken = await AccountApiToken("timed-token", {
  name: "Time Limited Token",
  policies: [{
    effect: "allow",
    permissionGroups: [
      { id: permissions["DNS Write"].id }
    ],
    resources: {
      "com.cloudflare.api.account.zone.*": "*"
    }
  }],
  notBefore: "2024-01-01T00:00:00Z",
  expiresOn: "2024-12-31T23:59:59Z"
});
```

# Bind to a Worker

Use the token in a Worker binding:

```ts
import { Worker, AccountApiToken } from "alchemy/cloudflare";

const token = await AccountApiToken("api-token", {
  name: "Worker API Token",
  policies: [{
    effect: "allow",
    permissionGroups: [
      { id: permissions["Cache Purge"].id }
    ],
    resources: {
      "com.cloudflare.api.account.*": "*" 
    }
  }]
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    API_TOKEN: token.value
  }
});
```