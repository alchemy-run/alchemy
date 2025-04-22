# DnsRecords

The DnsRecords component lets you manage [DNS records](https://developers.cloudflare.com/dns/manage-dns-records/) in a Cloudflare zone.

# Minimal Example

Create basic A and CNAME records for a domain.

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

Create MX and TXT records for email routing.

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
      type: "TXT",
      content: "v=spf1 include:_spf.google.com ~all"
    }
  ]
});
```

# Multiple Record Types

Create multiple record types with different configurations.

```ts
import { DnsRecords } from "alchemy/cloudflare";

const records = await DnsRecords("example.com-dns", {
  zoneId: "YOUR_ZONE_ID",
  records: [
    // A record with proxy enabled
    {
      name: "www",
      type: "A",
      content: "192.0.2.1",
      proxied: true
    },
    // CNAME with custom TTL
    {
      name: "blog",
      type: "CNAME", 
      content: "www.example.com",
      ttl: 3600
    },
    // TXT record with comment
    {
      name: "example.com",
      type: "TXT",
      content: "verification=abc123",
      comment: "Domain verification"
    }
  ]
});
```