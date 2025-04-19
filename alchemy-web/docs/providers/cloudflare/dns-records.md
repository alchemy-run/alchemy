# DnsRecords

The DnsRecords resource lets you manage [DNS records](https://developers.cloudflare.com/dns/) in a Cloudflare zone.

# Minimal Example

Create basic A and CNAME records for a domain:

```ts
import { DnsRecords } from "alchemy/cloudflare";

const records = await DnsRecords("example.com-dns", {
  zoneId: "YOUR_ZONE_ID",
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

Configure MX records for email routing:

```ts
import { DnsRecords } from "alchemy/cloudflare";

const emailRecords = await DnsRecords("example.com-email", {
  zoneId: "YOUR_ZONE_ID", 
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
    }
  ]
});
```

# Multiple Record Types

Create multiple record types with different settings:

```ts
import { DnsRecords } from "alchemy/cloudflare";

const multiRecords = await DnsRecords("example.com-multi", {
  zoneId: "YOUR_ZONE_ID",
  records: [
    {
      name: "www.example.com",
      type: "A",
      content: "192.0.2.1",
      proxied: true,
      ttl: 1 
    },
    {
      name: "api.example.com",
      type: "CNAME", 
      content: "api.service.com",
      proxied: false,
      ttl: 3600
    },
    {
      name: "example.com",
      type: "TXT",
      content: "v=spf1 include:_spf.google.com ~all"
    }
  ]
});
```