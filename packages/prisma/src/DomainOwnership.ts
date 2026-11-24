import * as DNS from "alchemy/DNS/Adapter";
import type { Input, PropsInput } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { type ProjectReference, recordDomainOf } from "./internal/DomainOwnership.ts";
import { type DomainOwnershipLookup, DomainOwnershipRow } from "./internal/DomainOwnershipRow.ts";
import { DomainVerification } from "./internal/DomainVerification.ts";
import { normalizeHostname } from "./internal/Hostname.ts";
import { publishesDns } from "./internal/PublishesDns.ts";
import { publishedRecordsId } from "./internal/RoutingUrlRequiredRecords.ts";

export { PrismaDomainOwnershipRequired } from "./internal/DomainOwnership.ts";
export type { DomainOwnershipLookup } from "./internal/DomainOwnershipRow.ts";

const recordSetId = (domain: string) =>
  publishedRecordsId(recordDomainOf(normalizeHostname(domain)));

/** A workspace's domain ownership, as the deploy last saw it. */
export type DomainOwnership = DomainOwnershipRow;

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
   * published first, and the deploy waits up to 3 minutes for it at the
   * authoritative nameservers before it saves the domain ownership and asks
   * Prisma to verify; it does not fail when the record never appears or
   * Prisma has not verified it. Nothing is published under `alchemy dev`.
   * Removing `dns` from a deployed domain ownership deletes the record, and a
   * verified domain ownership becomes `expiring` at Prisma's next lookup of
   * that record. Adding `dns` to a deployed domain ownership does not check
   * for a domain ownership of the wildcard or apex that shares the record
   * name, so prove only one of the two per zone. Omitted: publish
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
 * It proves ownership with a `TXT` record named `recordName` whose value,
 * `recordValue`, is the same for every domain in the workspace. The deploy
 * reports Prisma's `status`. Without `dns`, it saves the domain ownership
 * without waiting for DNS. With `dns`, the record is published for you, and
 * the domain ownership is saved and Prisma asked to verify once the record is
 * seen, or after 3 minutes. `unverified` at the end of a deploy means Prisma has not
 * seen the record yet. Prisma looks again when Check is pressed on the
 * workspace's Domains page or a RoutingUrl's `setupUrl`, when
 * `POST /v1/domain-ownerships/{id}/verify` or `POST /v1/urls/{id}/check` is
 * called, when a hostname it covers is created, updated or checked, and once
 * 10 minutes after a lookup that did not find the record. Each covered
 * RoutingUrl becomes `active` on its own once it is verified.
 * `status` is as of the deploy. A domain ownership that is not `verified` is
 * read again on every deploy, so `alchemy plan` lists it as an update until
 * Prisma verifies it: it checks its record once at the nameservers without
 * waiting for it, and only when the record is there waits about 10 seconds
 * and asks Prisma to verify. It logs a warning while it is still
 * `unverified` or `expiring`. A verified one is not read again. The Domains page shows it live.
 *
 * Destroying it deletes the domain ownership and, with `dns`, the record. A
 * domain ownership the stack did not create, made in the Console, by a
 * RoutingUrl with `createDomainOwnership: true`, by Prisma for an older
 * custom domain, or by another stack, needs `--adopt`, or better `adopt(true)`
 * on this resource alone; to use one without managing it, use `lookup`. With
 * `dns`, the refusal can name `Prisma.DomainVerification`, the resource that
 * checks for an existing domain ownership of this domain or of the wildcard
 * or apex that shares its record,
 * before the record is published. Adopting in
 * that last case makes the stack publish, and on destroy delete, the record
 * the other domain ownership also uses. Once two stacks have it,
 * destroying either deletes it for both, so declare a shared one in one
 * stack, with `RemovalPolicy.retain()` if it must outlive that stack. A
 * domain ownership belongs to a workspace: moving `project` to another
 * workspace fails the deploy and changes nothing. To recover, point `project`
 * back, or remove the domain ownership from the stack and deploy, which
 * deletes it from the old workspace unless it is retained, then declare it
 * again.
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
 * ### Using a Domain Ownership Managed Elsewhere
 * `Prisma.DomainOwnership.lookup` finds the workspace's domain ownership
 * for exactly `domain`, made in the Console or by another stack. It is read
 * while the deploy is planned, and never created, changed or deleted. The
 * deploy fails when there is none, or when this stack manages it. It asks
 * Prisma even under `alchemy dev`, and needs `workspaceManage` access.
 *
 * **Example:** Serve a site under a wildcard made in the Console
 * ```typescript
 * const example = Prisma.DomainOwnership.lookup({ project, domain: "*.example.com" });
 * yield* Prisma.Website.Vite("Web", {
 *   project,
 *   domain: { name: "www.example.com", dns: Cloudflare.DNS.Adapter(), ownership: example },
 * });
 * ```
 *
 * @resource
 * @product Compute
 */
export const DomainOwnership = Object.assign(
  (id: string, props: DomainOwnershipProps) =>
    Effect.gen(function* () {
      const dns = props.dns !== undefined && (yield* publishesDns) ? props.dns : undefined;
      const verification = yield* DomainVerification("Verification", {
        project: props.project,
        domain: props.domain,
        ...(dns === undefined ? {} : { publishesRecord: true }),
      });
      if (dns === undefined) {
        return yield* DomainOwnershipRow("Ownership", {
          project: props.project,
          domain: props.domain,
        });
      }
      const published = yield* (yield* DNS.resolve(dns)).records(recordSetId(props.domain), {
        records: Output.map(
          Output.all(verification.recordName, verification.recordValue),
          ([name, value]): DNS.DnsRecord[] => [{ name, type: "TXT", value }],
        ),
      });
      return yield* DomainOwnershipRow("Ownership", {
        project: props.project,
        domain: props.domain,
        publishesRecord: Output.map(Output.of(published as ResourceLike), () => true),
      });
    }).pipe(Namespace.push(id)),
  {
    lookup: (props: PropsInput<DomainOwnershipLookup>) => DomainOwnershipRow.lookup(props),
  },
);
