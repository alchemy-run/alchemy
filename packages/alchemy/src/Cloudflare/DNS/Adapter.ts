import type { DnsAdapter } from "../../AWS/DnsAdapter.ts";
import type { Input } from "../../Input.ts";
import type { Reference as ZoneReference } from "../Zone/lookup.ts";
import { AcmValidator } from "./AcmDnsValidator.ts";
import { Records } from "./Records.ts";

/**
 * Cloudflare DNS for AWS custom domains — point a hostname whose DNS lives
 * in a Cloudflare zone (e.g. a domain registered with Cloudflare Registrar)
 * at an AWS CloudFront distribution or load balancer.
 *
 * Pass it as `domain.dns` on `AWS.Website.*` sites, `AWS.Website.Router`,
 * or an `AWS.ECS.Service` load balancer domain. The composite then:
 *
 * - validates its ACM certificate through the zone (DNS-only CNAMEs, see
 *   {@link AcmValidator}), and
 * - points each hostname at the AWS target with a `CNAME` record
 *   (Cloudflare flattens a CNAME at the zone apex).
 *
 * The stack must include both `AWS.providers()` and `Cloudflare.providers()`.
 *
 * **Example:**
 * ```typescript
 * yield* AWS.Website.StaticSite("Site", {
 *   path: "./dist",
 *   domain: {
 *     name: "www.example.com",
 *     dns: Cloudflare.DNS.Adapter(),
 *   },
 * });
 * ```
 *
 * **Example:**
 * ```typescript
 * // `proxied: true` puts Cloudflare's CDN in front of CloudFront — set the
 * // zone's SSL/TLS mode to Full (strict).
 * yield* AWS.Website.StaticSite("Site", {
 *   path: "./dist",
 *   domain: {
 *     name: "example.com",
 *     dns: Cloudflare.DNS.Adapter({ zone: "example.com", proxied: true }),
 *   },
 * });
 * ```
 */
export const Adapter = (
  options: {
    /**
     * Zone id, zone name, or `Zone` resource. Inferred from each hostname
     * when omitted.
     */
    readonly zone?: Input<ZoneReference>;
    /**
     * Send the alias records through Cloudflare's proxy (orange cloud).
     * Validation records are always DNS-only.
     * @default false
     */
    readonly proxied?: boolean;
  } = {},
): DnsAdapter => {
  const common = {
    type: "CNAME" as const,
    ...(options.zone === undefined ? {} : { zone: options.zone }),
    ...(options.proxied === undefined ? {} : { proxied: options.proxied }),
  };
  return {
    validation: AcmValidator({ zone: options.zone }),
    // Every alias is a one-name record set: the zone is inferred at
    // reconcile time (no plan-time lookup) and the record is overwritten
    // like a Route 53 UPSERT. The `-CNAME` suffix keeps the logical id
    // distinct from the Route 53 records it replaces when a domain moves
    // between DNS providers.
    alias: (id, { name, target }) =>
      Records(`${id}-CNAME`, {
        ...common,
        content: target.dnsName,
        names: [name],
      }),
    aliasSet: (id, { target, names }) =>
      Records(`${id}-CNAME`, {
        ...common,
        content: target.dnsName,
        ...(names === undefined ? {} : { names }),
      }),
  };
};
