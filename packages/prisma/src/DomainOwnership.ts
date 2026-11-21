import * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { ProjectReference } from "./internal/DomainOwnership.ts";
import { DomainOwnershipProof } from "./internal/DomainOwnershipProof.ts";
import { DomainVerification } from "./internal/DomainVerification.ts";

export { PrismaDomainOwnershipRequired } from "./internal/DomainOwnership.ts";

/** A domain a Prisma workspace has proved it owns. */
export type DomainOwnership = DomainOwnershipProof;

export interface DomainOwnershipProps {
  /** Project (or project ID) whose workspace proves ownership. */
  project: Input<ProjectReference>;
  /**
   * An exact hostname such as `app.example.com`, or a wildcard such as
   * `*.example.com`. A wildcard and its apex share one record name
   * (`_prisma-verification.example.com`).
   */
  domain: string;
  /**
   * DNS host that publishes the verification `TXT` record, e.g.
   * `Cloudflare.DNS.Adapter()` (see
   * [DNS Adapters](/infrastructure-as-code/dns-adapters)). Omitted: publish
   * it yourself; until it resolves, the deploy fails with
   * {@link PrismaDomainOwnershipRequired}, which names the record.
   */
  dns?: DNS.DnsConfig;
}

const publishVerificationRecord = (
  project: Input<ProjectReference>,
  domain: string,
  dnsConfig: DNS.DnsConfig,
) =>
  Effect.gen(function* () {
    const dns = yield* DNS.resolve(dnsConfig);
    const verification = yield* DomainVerification("Verification", { project, domain });
    return yield* dns.records("Record", {
      records: Output.map(
        Output.all(verification.recordName, verification.recordValue),
        ([name, value]): DNS.DnsRecord[] => [{ name, type: "TXT", value }],
      ),
    });
  });

/**
 * A domain ownership: Prisma's record that a workspace has proved it owns a
 * domain, which is an exact hostname or a wildcard. A hostname serves only
 * once a verified domain ownership covers it.
 *
 * Prisma creates the domain ownership for a `Prisma.RoutingUrl`'s exact
 * hostname itself. Don't declare this resource for that same hostname: it
 * takes over the domain ownership Prisma created and deletes it on destroy.
 * A wildcard such as `*.example.com` covers every hostname under it, so a
 * RoutingUrl there serves without a `TXT` record of its own; one with `dns`
 * still publishes its own `TXT`, which does no harm.
 *
 * The proof is a `TXT` record named `_prisma-verification.{domain}` whose
 * value is the same for every domain in the workspace; a wildcard and its apex
 * share one record name. With `dns`, the record is published for you. The
 * deploy creates nothing while an authoritative nameserver answers without the
 * record, and succeeds once Prisma reports the ownership `verified`. `status`
 * and `expiresAt` are what Prisma reported when the deploy last proved the
 * domain; an unchanged redeploy does not check again. Destroying the resource
 * removes the ownership and the record.
 *
 * ### Proving a Domain
 * **Example:** Prove a wildcard for the hostnames under it
 * ```typescript
 * yield* Prisma.DomainOwnership("example.com", {
 *   project,
 *   domain: "*.example.com",
 *   dns: Cloudflare.DNS.Adapter(),
 * });
 * yield* Prisma.RoutingUrl("api", { app: api, hostname: "api.example.com" });
 * yield* Prisma.RoutingUrl("admin", { app: admin, hostname: "admin.example.com" });
 * ```
 *
 * **Example:** Publish the record with your own DNS host
 * ```typescript
 * // fails with PrismaDomainOwnershipRequired until
 * // TXT _prisma-verification.example.com resolves
 * const ownership = yield* Prisma.DomainOwnership("example.com", {
 *   project,
 *   domain: "*.example.com",
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const DomainOwnership = (id: string, props: DomainOwnershipProps) =>
  Effect.gen(function* () {
    const published = props.dns
      ? yield* publishVerificationRecord(props.project, props.domain, props.dns)
      : undefined;
    return yield* DomainOwnershipProof("Ownership", {
      project: props.project,
      // Proving looks the record up, so it must be published first.
      domain:
        published === undefined
          ? props.domain
          : Output.map(Output.of(published as ResourceLike), () => props.domain),
    });
  }).pipe(Namespace.push(id));
