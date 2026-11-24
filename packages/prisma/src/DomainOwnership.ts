import * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { ProjectReference } from "./internal/DomainOwnership.ts";
import { DomainOwnershipCheck } from "./internal/DomainOwnershipCheck.ts";
import { DomainOwnershipProof } from "./internal/DomainOwnershipProof.ts";
import { publishesDns } from "./internal/PublishesDns.ts";

export { PrismaDomainOwnershipRequired } from "./internal/DomainOwnership.ts";

/** A workspace's domain ownership, as the deploy last saw it. */
export type DomainOwnership = DomainOwnershipProof | DomainOwnershipCheck;

export interface DomainOwnershipProps {
  /** Project (or project ID) whose workspace owns the domain ownership. */
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
   * [DNS Adapters](/infrastructure-as-code/dns-adapters)). The record is
   * published after the domain ownership is saved, and the deploy waits up to
   * 3 minutes for it at the authoritative nameservers before asking Prisma to
   * verify; it does not fail when the record never appears or Prisma has not
   * verified it. Nothing is published under `alchemy dev`. Omitted: publish
   * `recordName` and `recordValue` yourself.
   */
  dns?: DNS.DnsConfig;
}

/**
 * A domain ownership: the workspace's record that it owns a domain, an exact
 * hostname or a wildcard. A `Prisma.RoutingUrl` serves only once a verified
 * domain ownership covers its hostname. It belongs to the workspace, not to a
 * project: every project in the workspace can use it.
 *
 * The deploy saves it without waiting for DNS, and reports Prisma's `status`.
 * It proves ownership with a `TXT` record named `recordName` whose value,
 * `recordValue`, is the same for every domain in the workspace. With `dns`
 * the record is published for you, and Prisma is asked to verify once the
 * record is seen. `unverified` at the end of a deploy means Prisma has not
 * seen the record yet: with `dns`, Prisma picks it up later on its own;
 * without `dns`, publish it, then press Check on the workspace's Domains page
 * or call `POST /v1/domain-ownerships/{id}/verify` to make Prisma look now.
 * Each covered RoutingUrl becomes `active` on its own once it is verified.
 * `status` is as of the deploy's last write or verify request, and an
 * unchanged redeploy does not read it again; the Domains page shows it live.
 *
 * Destroying it deletes the domain ownership and, with `dns`, the record. A
 * domain ownership the stack did not create, made in the Console, by a
 * RoutingUrl with `createDomainOwnership: true`, by Prisma for an older
 * custom domain, or by another stack, needs `--adopt`, or better `adopt(true)`
 * on this resource alone. Once two stacks have it, destroying either deletes
 * it for both, so declare a shared one in one stack, with
 * `RemovalPolicy.retain()` if it must outlive that stack.
 *
 * ### Proving a Domain
 * **Example:** Prove a hostname and serve it
 * ```typescript
 * yield* Prisma.DomainOwnership("api-domain", {
 *   project,
 *   domain: "api.example.com",
 *   dns: Cloudflare.DNS.Adapter(),
 * });
 * yield* Prisma.RoutingUrl("api", {
 *   app: api,
 *   hostname: "api.example.com",
 *   dns: Cloudflare.DNS.Adapter(),
 * });
 * ```
 *
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
 * const ownership = yield* Prisma.DomainOwnership("example.com", {
 *   project,
 *   domain: "*.example.com",
 * });
 * // ownership.status: "unverified" until TXT ownership.recordName,
 * // with value ownership.recordValue, is published and Prisma looks
 * ```
 *
 * @resource
 * @product Compute
 */
export const DomainOwnership = (id: string, props: DomainOwnershipProps) =>
  Effect.gen(function* () {
    const dns = props.dns !== undefined && (yield* publishesDns) ? props.dns : undefined;
    const row = yield* DomainOwnershipProof("Ownership", {
      project: props.project,
      domain: props.domain,
      ...(dns === undefined ? {} : { publishesRecord: true }),
    });
    if (dns === undefined) return row;
    const published = yield* (yield* DNS.resolve(dns)).records("Record", {
      records: Output.map(
        Output.all(row.recordName, row.recordValue),
        ([name, value]): DNS.DnsRecord[] => [{ name, type: "TXT", value }],
      ),
    });
    return yield* DomainOwnershipCheck("Check", {
      domainOwnershipId: Output.map(
        Output.all(row.domainOwnershipId, Output.of(published as ResourceLike)),
        ([domainOwnershipId]) => domainOwnershipId,
      ),
      recordName: row.recordName,
      recordValue: row.recordValue,
    });
  }).pipe(Namespace.push(id));
