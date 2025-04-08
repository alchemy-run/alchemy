# Import DNS Records

The Import DNS Records component lets you fetch DNS records for a domain using [Cloudflare's DNS-over-HTTPS API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/).

# Minimal Example

Import all default DNS record types for a domain.

```ts
import { ImportDnsRecords } from "alchemy/dns";

const dnsRecords = await ImportDnsRecords("dns-records", {
  domain: "example.com"
});
```

# Import Specific Record Types

Import only specific DNS record types.

```ts
import { ImportDnsRecords } from "alchemy/dns";

const specificRecords = await ImportDnsRecords("dns-records", {
  domain: "example.com",
  recordTypes: ["A", "MX"]
});
```

# Transfer DNS Records

Import DNS records and transfer them to a Cloudflare zone.

```ts
import { ImportDnsRecords, DnsRecords, Zone } from "alchemy/dns";

const dnsRecords = await ImportDnsRecords("dns-records", {
  domain: "example.com"
});

const zone = await Zone("example.com", {
  name: "example.com",
  type: "full"
});

await DnsRecords("transfer-dns-records", {
  zoneId: zone.id,
  records: dnsRecords.records
});
```