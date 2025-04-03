# Dns

The Dns component allows you to manage [Cloudflare DNS](https://developers.cloudflare.com/dns/) records for your domain. It supports creating, updating, and deleting multiple DNS records at once.

# Minimal Example

```ts
import { DnsRecords } from "alchemy/cloudflare";

const dnsRecords = await DnsRecords("example.com-dns", {
  zoneId: "your-zone-id",
  records: [
    {
      name: "www.example.com",
      type: "A",
      content: "192.0.2.1",
      proxied: true
    }
  ]
});
```

# Create the Dns

```ts
import { DnsRecords } from "alchemy/cloudflare";

const dnsRecords = await DnsRecords("example.com-dns", {
  zoneId: "your-zone-id",
  records: [
    {
      name: "www.example.com",
      type: "A",
      content: "192.0.2.1",
      proxied: true
    },
    {
      name: "blog.example.com",
      type: "CNAME",
      content: "www.example.com",
      proxied: true
    }
  ]
});
```

# Bind to a Worker

```ts
import { Worker, DnsRecords } from "alchemy/cloudflare";

const myDnsRecords = await DnsRecords("example.com-dns", {
  zoneId: "your-zone-id",
  records: [
    {
      name: "api.example.com",
      type: "A",
      content: "192.0.2.2",
      proxied: true
    }
  ]
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myDnsRecords,
  },
});
```