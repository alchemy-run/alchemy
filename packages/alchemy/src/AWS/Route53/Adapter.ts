import * as Effect from "effect/Effect";
import type { DnsAdapter } from "../DnsAdapter.ts";
import { Record } from "./Record.ts";
import { Records } from "./Records.ts";

/**
 * Route 53 DNS for AWS custom domains — the default a composite uses when
 * its `domain.dns` is omitted. Hostnames get `A` alias records (plus `AAAA`
 * where the target serves IPv6) and ACM certificates are validated in the
 * hosted zone.
 *
 * **Example:**
 * ```typescript
 * yield* AWS.Website.StaticSite("Site", {
 *   path: "./dist",
 *   domain: {
 *     name: "www.example.com",
 *     dns: AWS.Route53.Adapter({ hostedZoneId }),
 *   },
 * });
 * ```
 */
export const Adapter = (
  options: {
    /**
     * Hosted zone that owns the records. Inferred per hostname (most
     * specific public zone) when omitted.
     */
    readonly hostedZoneId?: string;
  } = {},
): DnsAdapter => ({
  hostedZoneId: options.hostedZoneId,
  validation: undefined,
  alias: (id, { name, target, ipv6 }) =>
    Effect.forEach(ipv6 ? (["A", "AAAA"] as const) : (["A"] as const), (type) =>
      // Logical ids: `id` for a lone A record, `id-A` / `id-AAAA` for a
      // dual-stack pair.
      Record(ipv6 ? `${id}-${type}` : id, {
        hostedZoneId: options.hostedZoneId,
        name,
        type,
        aliasTarget: {
          hostedZoneId: target.hostedZoneId,
          dnsName: target.dnsName,
          ...(target.evaluateTargetHealth === undefined
            ? {}
            : { evaluateTargetHealth: target.evaluateTargetHealth }),
        },
      }),
    ),
  aliasSet: (id, { target, names }) =>
    Records(id, {
      hostedZoneId: options.hostedZoneId,
      type: "A",
      ...(names === undefined ? {} : { names }),
      aliasTarget: {
        hostedZoneId: target.hostedZoneId,
        dnsName: target.dnsName,
      },
    }),
});
