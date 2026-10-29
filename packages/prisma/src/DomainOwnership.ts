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

/**
 * Proof that a Prisma workspace owns a domain. Prisma refuses a
 * `Prisma.CustomDomain` until the workspace owns its hostname, through an
 * exact hostname or a wildcard.
 *
 * The proof is a `TXT` record named `_prisma-verification.{domain}` whose
 * value is the same for every domain in the workspace. With `dns`, the
 * record is published for you, then Prisma checks it. Destroying the
 * resource removes the ownership and the record; custom domains attached
 * under it stay attached.
 *
 * `Prisma.Website` composites prove their own hostname when `domain` names a
 * DNS host (`domain: { name, dns }`), so declare this resource only to prove
 * a wildcard once for many apps.
 *
 * ### Proving a Domain
 * **Example:** Prove a wildcard once for many apps
 * ```typescript
 * yield* Prisma.DomainOwnership("example.com", {
 *   project,
 *   domain: "*.example.com",
 *   dns: Cloudflare.DNS.Adapter(),
 * });
 * yield* Prisma.CustomDomain("api", { app: api, hostname: "api.example.com" });
 * yield* Prisma.CustomDomain("admin", { app: admin, hostname: "admin.example.com" });
 * ```
 *
 * **Example:** Publish the record with your own DNS host
 * ```typescript
 * // fails with PrismaDomainOwnershipRequired until
 * // TXT _prisma-verification.app.example.com resolves
 * const ownership = yield* Prisma.DomainOwnership("app", {
 *   project,
 *   domain: "app.example.com",
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const DomainOwnership = (id: string, props: DomainOwnershipProps) =>
  Effect.gen(function* () {
    const dnsConfig = props.dns;
    const published = dnsConfig
      ? yield* Effect.gen(function* () {
          const dns = yield* DNS.resolve(dnsConfig);
          const verification = yield* DomainVerification("Verification", {
            project: props.project,
            domain: props.domain,
          });
          return yield* dns.records("Record", {
            records: Output.map(
              Output.all(verification.recordName, verification.recordValue),
              ([name, value]): DNS.DnsRecord[] => [{ name, type: "TXT", value }],
            ),
          });
        })
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
