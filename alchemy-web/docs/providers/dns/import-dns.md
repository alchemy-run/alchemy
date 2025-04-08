# ImportDnsRecords

The ImportDnsRecords component lets you import DNS records from a domain using [Cloudflare's DNS-over-HTTPS API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/).

# Minimal Example

Import all default DNS record types for a domain.

```ts
import { ImportDnsRecords } from "alchemy/dns";

const dnsRecords = await ImportDnsRecords("dns-records", {
  domain: "example.com"
});
```

# Import Specific Record Types

Import only specified DNS record types.

```ts
import { ImportDnsRecords } from "alchemy/dns";

const records = await ImportDnsRecords("dns-records", {
  domain: "example.com",
  recordTypes: ["A", "MX"]
});
```

# Import and Transfer Records

Import DNS records and transfer them to another provider.

```ts
import { ImportDnsRecords, DnsRecords } from "alchemy/dns";

const dnsRecords = await ImportDnsRecords("dns-records", {
  domain: "example.com"
});

// Records are directly compatible with DnsRecords function
await DnsRecords("transfer-dns-records", {
  zoneId: zone.id,
  records: dnsRecords.records
});
```