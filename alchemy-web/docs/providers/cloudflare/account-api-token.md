# AccountApiToken

Creates a [Cloudflare API Token](https://developers.cloudflare.com/api/tokens/) with specified permissions and access controls.

# Minimal Example

Create a basic API token with read-only permissions.

```ts
import { AccountApiToken, PermissionGroups } from "alchemy/cloudflare";

const permissions = await PermissionGroups("cloudflare-permissions");

const token = await AccountApiToken("readonly-token", {
  name: "Readonly Zone Token",
  policies: [{
    effect: "allow",
    permissionGroups: [
      { id: permissions["Zone Read"].id },
      { id: permissions["Analytics Read"].id }
    ],
    resources: {
      "com.cloudflare.api.account.zone.*": "*"
    }
  }]
});
```

# With Time and IP Restrictions

Create a token with time-based and IP address restrictions.

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
      in: ["192.168.1.0/24"],
      notIn: ["192.168.1.100/32"]
    }
  }
});
```

# Bind to a Worker

Use the token in a Worker binding.

```ts
import { Worker, AccountApiToken } from "alchemy/cloudflare";

const token = await AccountApiToken("api-token", {
  name: "Worker API Token",
  policies: [{
    effect: "allow", 
    permissionGroups: [
      { id: permissions["Zone Read"].id }
    ],
    resources: {
      "com.cloudflare.api.account.zone.*": "*" 
    }
  }]
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    API_TOKEN: token
  }
});
```