# Dns

The Dns component allows you to manage [Cloudflare DNS Records](https://developers.cloudflare.com/dns/) for your domain. It supports creating, updating, and deleting multiple DNS records at once.

# Minimal Example

```ts
import { Dns } from "alchemy/cloudflare";

const dnsRecords = await Dns("example.com-dns", {
  zoneId: "example-zone-id",
  records: [
    {
      name: "www.example.com",
      type: "A",
      content: "192.0.2.1",
      proxied: true,
    },
  ],
});
```

# Create the Dns

```ts
import { Dns } from "alchemy/cloudflare";

const dnsRecords = await Dns("example.com-dns", {
  zoneId: "example-zone-id",
  records: [
    {
      name: "www.example.com",
      type: "A",
      content: "192.0.2.1",
      proxied: true,
    },
    {
      name: "blog.example.com",
      type: "CNAME",
      content: "www.example.com",
      proxied: true,
    },
  ],
});
```

# Bind to a Worker

```ts
import { Worker, Dns } from "alchemy/cloudflare";

const myDns = await Dns("my-dns", {
  zoneId: "example-zone-id",
  records: [
    {
      name: "api.example.com",
      type: "A",
      content: "192.0.2.2",
      proxied: true,
    },
  ],
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myDns,
  },
});
```