import type { Context } from "../context";
import { Resource } from "../resource";

/**
 * DNS record types supported by the API
 */
export type DNSRecordType =
  | "A"
  | "AAAA"
  | "MX"
  | "TXT"
  | "NS"
  | "CNAME"
  | "SOA"
  | "SRV";

/**
 * Default DNS record types to fetch
 */
export const DEFAULT_RECORD_TYPES: readonly DNSRecordType[] = [
  "A",
  "AAAA",
  "MX",
  "TXT",
  "NS",
  "CNAME",
  "SOA",
  "SRV",
] as const;

/**
 * DNS record response structure from Cloudflare DNS API
 */
export interface DNSRecord {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

/**
 * Cloudflare DNS-over-HTTPS API response structure
 */
interface CloudflareDNSResponse {
  Status: number;
  TC: boolean;
  RD: boolean;
  RA: boolean;
  AD: boolean;
  CD: boolean;
  Question: Array<{
    name: string;
    type: number;
  }>;
  Answer?: DNSRecord[];
}

/**
 * Properties for importing DNS records
 */
export interface ImportDnsRecordsProps {
  /**
   * The domain to fetch DNS records for
   */
  domain: string;

  /**
   * Specific record types to fetch. If not provided, defaults to all supported types.
   */
  recordTypes?: DNSRecordType[];
}

/**
 * Output returned after DNS records import
 */
export interface ImportDnsRecords
  extends Resource<"dns::ImportDnsRecords">,
    ImportDnsRecordsProps {
  /**
   * The DNS records grouped by type
   */
  records: Record<DNSRecordType, DNSRecord[]>;

  /**
   * Time at which the records were imported
   */
  importedAt: number;
}

/**
 * Import DNS records for a domain using Cloudflare's DNS-over-HTTPS API.
 * This resource allows you to fetch DNS records for a domain and store them
 * in a structured format.
 *
 * @example
 * // Import all default record types
 * const allRecords = await ImportDnsRecords("example.com", {
 *   domain: "example.com"
 * });
 *
 * @example
 * // Import only specific record types
 * const specificRecords = await ImportDnsRecords("example.com", {
 *   domain: "example.com",
 *   recordTypes: ["A", "MX"]
 * });
 */
export const ImportDnsRecords = Resource(
  "dns::ImportDnsRecords",
  async function (
    this: Context<ImportDnsRecords>,
    id: string,
    props: ImportDnsRecordsProps,
  ): Promise<ImportDnsRecords> {
    // For delete phase, just return destroyed state since this is a read-only resource
    if (this.phase === "delete") {
      return this.destroy();
    }

    const recordTypes = props.recordTypes || DEFAULT_RECORD_TYPES;
    const results: Partial<Record<DNSRecordType, DNSRecord[]>> = {};

    for (const type of recordTypes) {
      try {
        const res = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${props.domain}&type=${type}`,
          {
            headers: {
              accept: "application/dns-json",
            },
          },
        );

        if (!res.ok) {
          throw new Error(`Failed to fetch ${type} records: ${res.statusText}`);
        }

        const data = (await res.json()) as CloudflareDNSResponse;

        if (data.Answer) {
          results[type] = data.Answer;
        }
      } catch (error) {
        console.warn(
          `Failed to fetch ${type} records for ${props.domain}:`,
          error,
        );
      }
    }

    // Return the resource with fetched records
    return this({
      domain: props.domain,
      recordTypes: [...recordTypes],
      records: results as Record<DNSRecordType, DNSRecord[]>,
      importedAt: Date.now(),
    });
  },
);
