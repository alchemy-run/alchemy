# Import Dns Records

The Import Dns Records component allows you to fetch DNS records for a domain using Cloudflare's DNS-over-HTTPS API. This resource provides a structured format for DNS records, making them compatible with other DNS management functions.

# Minimal Example

```ts
import { ImportDnsRecords } from "alchemy/dns";

const allRecords = await ImportDnsRecords("example.com", {
  domain: "example.com"
});
```

# Create the Import Dns Records

```ts
import { ImportDnsRecords } from "alchemy/dns";

// Import only specific record types
const specificRecords = await ImportDnsRecords("example.com", {
  domain: "example.com",
  recordTypes: ["A", "MX"]
});

// Import DNS records and transfer them to a Cloudflare zone
const dnsRecords = await ImportDnsRecords("dns-records", {
  domain: "example.com",
});

const zone = await Zone("example.com", {
  name: "example.com",
  type: "full",
});

// Records are directly compatible with DnsRecords function
await DnsRecords("transfer-dns-records", {
  zoneId: zone.id,
  records: dnsRecords.records,
});
```