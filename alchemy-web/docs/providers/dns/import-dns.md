# Import Dns Records

The Import Dns Records component lets you fetch DNS records for a domain using [Cloudflare's DNS-over-HTTPS API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/).

# Minimal Example

Import all default DNS record types for a domain.

```ts
import { ImportDnsRecords } from "alchemy/dns";

const records = await ImportDnsRecords("example.com", {
  domain: "example.com"
});
```

# Import Specific Record Types

```ts
import { ImportDnsRecords } from "alchemy/dns";

const records = await ImportDnsRecords("example.com", {
  domain: "example.com",
  recordTypes: ["A", "MX"]
});
```

# Import and Transfer DNS Records

```ts
import { ImportDnsRecords, DnsRecords, Zone } from "alchemy/dns";

// Import existing records
const dnsRecords = await ImportDnsRecords("dns-records", {
  domain: "example.com",
});

// Create zone
const zone = await Zone("example.com", {
  name: "example.com",
  type: "full",
});

// Transfer records to new zone
await DnsRecords("transfer-dns-records", {
  zoneId: zone.id,
  records: dnsRecords.records,
});
```