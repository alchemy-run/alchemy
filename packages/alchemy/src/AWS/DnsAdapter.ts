import type * as Effect from "effect/Effect";
import type { Input } from "../Input.ts";
import type { Resource, ResourceLike } from "../Resource.ts";
import type { DnsValidatorDescriptor } from "./ACM/DnsValidator.ts";

/**
 * Where an alias record points: a CloudFront distribution or a load
 * balancer. Route 53 uses both fields for an ALIAS record; other DNS
 * providers use `dnsName` as a CNAME target.
 */
export interface DnsAliasTarget {
  /** Hostname of the target (e.g. `d123.cloudfront.net`, an ALB DNS name). */
  dnsName: Input<string>;
  /** Route 53 hosted zone id of the target (ignored outside Route 53). */
  hostedZoneId: Input<string>;
  /** Route 53 alias `EvaluateTargetHealth` (ignored outside Route 53). */
  evaluateTargetHealth?: boolean;
}

/** Binding contract of a {@link DnsAdapter.aliasSet} record set. */
export type DnsAliasSetBinding = {
  /** Additional hostnames pointed at the set's target. */
  names?: string[];
};

/**
 * A record set that composites bind hostnames onto (see
 * `AWS.Website.Router`'s `bindTargets.records`) — `AWS.Route53.Records` or
 * `Cloudflare.DNS.Records`.
 */
export type DnsAliasSet = ResourceLike<
  string,
  any,
  any,
  DnsAliasSetBinding,
  any
> &
  Pick<Resource<string, any, any, DnsAliasSetBinding, any>, "bind">;

/**
 * Pluggable DNS for AWS custom domains: how a composite (a website, a
 * Router, an ECS service) validates its ACM certificate and points
 * hostnames at a CloudFront distribution or load balancer.
 *
 * - `AWS.Route53.Adapter()` — Route 53 (the default when `dns` is omitted).
 * - `Cloudflare.DNS.Adapter()` — a domain whose DNS lives in Cloudflare
 *   (e.g. registered with Cloudflare Registrar).
 */
export interface DnsAdapter {
  /**
   * Route 53 hosted zone passed to `ACM.Certificate` for validation.
   * Route 53 adapter only.
   */
  readonly hostedZoneId?: string | undefined;
  /**
   * Validator passed to `ACM.Certificate`'s `dnsValidation`. `undefined`
   * selects the certificate's built-in Route 53 validation (and marks the
   * adapter as Route 53-backed).
   */
  readonly validation?: DnsValidatorDescriptor | undefined;
  /**
   * Point one hostname at `target`. `ipv6` also creates an IPv6 record where
   * the provider needs one (Route 53 `AAAA` alias; a CNAME already covers
   * both).
   */
  alias(
    id: string,
    args: { name: string; target: DnsAliasTarget; ipv6?: boolean },
  ): Effect.Effect<unknown, any, any>;
  /**
   * A (possibly empty) record set pointing at `target` that other
   * composites bind hostnames onto via `{ names }`.
   */
  aliasSet(
    id: string,
    args: { target: DnsAliasTarget; names?: string[] },
  ): Effect.Effect<DnsAliasSet, any, any>;
}
