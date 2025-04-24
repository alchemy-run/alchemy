# DnsRecords

The DnsRecords component lets you manage multiple DNS records in a [Cloudflare zone](https://developers.cloudflare.com/dns/manage-dns-records/).

# Minimal Example

Create basic A and CNAME records:

```ts
import { DnsRecords } from "alchemy/cloudflare";

const records = await DnsRecords("example.com-dns", {
  zoneId: "example.com", 
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

# Email Records

Create MX and TXT records for email routing:

```ts
import { DnsRecords } from "alchemy/cloudflare";

const emailRecords = await DnsRecords("example.com-email", {
  zoneId: "example.com",
  records: [
    {
      name: "example.com",
      type: "MX", 
      content: "aspmx.l.google.com",
      priority: 1
    },
    {
      name: "example.com",
      type: "MX",
      content: "alt1.aspmx.l.google.com", 
      priority: 5
    },
    {
      name: "example.com",
      type: "TXT",
      content: "v=spf1 include:_spf.google.com ~all"
    }
  ]
});
```

# Bind to a Worker

Use DNS records with a Cloudflare Worker:

```ts
import { Worker, DnsRecords } from "alchemy/cloudflare";

const records = await DnsRecords("api-dns", {
  zoneId: "example.com",
  records: [
    {
      name: "api.example.com",
      type: "A",
      content: "192.0.2.1",
      proxied: true
    }
  ]
});

await Worker("api", {
  name: "api-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    DNS: records
  }
});
```