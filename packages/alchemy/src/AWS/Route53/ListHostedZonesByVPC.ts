import type * as route53 from "@distilled.cloud/aws/route-53";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListHostedZonesByVPC` operation (IAM action
 * `route53:ListHostedZonesByVPC`; list actions do not support resource-level
 * permissions, so it is granted on `*`).
 *
 * Lists the private hosted zones associated with a VPC — discovery for
 * compute that audits or wires up split-horizon DNS at runtime. Provide the
 * implementation with `Effect.provide(AWS.Route53.ListHostedZonesByVPCHttp)`.
 * @binding
 * @section Discovering Zones
 * @example List a VPC's private zones
 * ```typescript
 * const listByVpc = yield* AWS.Route53.ListHostedZonesByVPC();
 *
 * const { HostedZoneSummaries } = yield* listByVpc({
 *   VPCId: "vpc-0123456789abcdef0",
 *   VPCRegion: "us-east-1",
 * });
 * ```
 */
export interface ListHostedZonesByVPC extends Binding.Service<
  ListHostedZonesByVPC,
  "AWS.Route53.ListHostedZonesByVPC",
  () => Effect.Effect<
    (
      request: route53.ListHostedZonesByVPCRequest,
    ) => Effect.Effect<
      route53.ListHostedZonesByVPCResponse,
      route53.ListHostedZonesByVPCError
    >
  >
> {}
export const ListHostedZonesByVPC = Binding.Service<ListHostedZonesByVPC>(
  "AWS.Route53.ListHostedZonesByVPC",
);
