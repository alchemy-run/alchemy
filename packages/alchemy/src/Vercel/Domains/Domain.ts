import * as domains from "@distilled.cloud/vercel/domains";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Providers } from "../Providers.ts";

export interface DomainProps {
  /**
   * The apex domain name to add to the Vercel team, e.g. `example.com`.
   * Changing the name replaces the domain.
   */
  name: string;
  /**
   * Whether to create a DNS zone on Vercel for the domain. Required before
   * any `Vercel.DnsRecord` can be created for it. The flag is immutable on
   * the platform (re-adding an existing domain does not update it), so
   * changing it replaces the domain (delete-first — the physical name is
   * identical either side of the replacement).
   *
   * @default true
   */
  zone?: boolean;
  /**
   * Whether the domain has the Vercel Edge Network enabled. Immutable on the
   * platform — changing it replaces the domain (delete-first).
   *
   * @default true (Vercel's default)
   */
  cdnEnabled?: boolean;
}

export type Domain = Resource<
  "Vercel.Domain",
  DomainProps,
  {
    /** The unique identifier of the domain (content-addressed by name). */
    domainId: string;
    /** The domain name. */
    name: string;
    /** Whether Vercel has verified ownership of the domain. */
    verified: boolean;
    /** Current nameservers of the domain. */
    nameservers: string[];
    /** Nameservers to point the domain at Vercel DNS. */
    intendedNameservers: string[];
    /**
     * `external` if DNS is externally handled, `zeit.world` if handled by
     * Vercel, `na` if unavailable.
     */
    serviceType: string;
    /** Timestamp (ms) when the domain was added. */
    createdAt: number;
  },
  never,
  Providers
>;

type DomainAttributes = Domain["Attributes"];

/**
 * An apex domain registered as a domain-of-record on the Vercel team.
 *
 * Adding a `Domain` makes the name available for `Vercel.DnsRecord`s (when
 * `zone` is enabled, the default) and for attaching to projects via
 * `Vercel.ProjectDomain`. Vercel has no tags and domains carry no metadata
 * channel, so ownership is tracked purely through the domain's
 * user-specified name plus alchemy state — `read` without prior state
 * reports an existing domain as unowned, gating takeover behind `--adopt`.
 *
 * @resource
 * @section Adding a Domain
 * @example Domain with a Vercel DNS zone (default)
 * ```typescript
 * const zone = yield* Vercel.Domain("Zone", { name: "acme.com" });
 * ```
 *
 * @example Externally-managed domain without a Vercel DNS zone
 * ```typescript
 * const domain = yield* Vercel.Domain("Apex", {
 *   name: "acme.com",
 *   zone: false,
 * });
 * ```
 *
 * @section DNS records on the domain
 * @example CNAME for a subdomain
 * ```typescript
 * const zone = yield* Vercel.Domain("Zone", { name: "acme.com" });
 * yield* Vercel.DnsRecord("Www", {
 *   domain: zone,
 *   type: "CNAME",
 *   name: "www",
 *   value: "cname.vercel-dns.com",
 * });
 * ```
 *
 * @see https://vercel.com/docs/domains
 */
export const Domain = Resource<Domain>("Vercel.Domain");

const toAttributes = (
  domain:
    | domains.GetDomainResponseDomain
    | domains.GetDomainsResponseDomainsItem,
): DomainAttributes => ({
  domainId: domain.id,
  name: domain.name,
  verified: domain.verified,
  nameservers: [...domain.nameservers],
  intendedNameservers: [...domain.intendedNameservers],
  serviceType: domain.serviceType,
  createdAt: domain.createdAt,
});

const observeDomain = (name: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    return yield* domains.getDomain({ domain: name, teamId }).pipe(
      Effect.map((res) => toAttributes(res.domain)),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  });

export const DomainProvider = () =>
  Provider.succeed(Domain, {
    stables: ["domainId", "name"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (news.name !== olds.name) {
        return { action: "replace" } as const;
      }
      // `zone`/`cdnEnabled` are immutable platform flags (re-adding an
      // existing domain does not update them) and the physical name is
      // identical across the replacement, so the old domain must be deleted
      // before the new one is created.
      if (
        (news.zone ?? true) !== (olds.zone ?? true) ||
        news.cdnEnabled !== olds.cdnEnabled
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const name = output?.name ?? olds?.name;
      if (name === undefined) return undefined;
      const attrs = yield* observeDomain(name);
      if (attrs === undefined) return undefined;
      // Vercel domains have no ownership channel (no tags, no env). With
      // prior state the engine already knows the domain is ours; without it
      // an existing domain could equally be a foreign domain-of-record, so
      // gate takeover behind `--adopt`.
      return output !== undefined ? attrs : Unowned(attrs);
    }),
    list: Effect.fn(function* () {
      const { teamId } = yield* VercelEnvironment.current;
      const rows: DomainAttributes[] = [];
      let until: number | undefined;
      do {
        const page = yield* domains.getDomains({ teamId, limit: 100, until });
        rows.push(...page.domains.map(toAttributes));
        until = page.pagination.next ?? undefined;
      } while (until !== undefined);
      return rows;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const { teamId } = yield* VercelEnvironment.current;
      // Observe — the domain may already exist (crash recovery, adoption).
      const observed = yield* observeDomain(news.name);
      if (observed === undefined) {
        // Ensure — `createOrTransferDomain` with a bare body adds the
        // domain. NOTE: `method: "add"` must be omitted (the server-side
        // oneOf rejects `{name, method: "add"}` — see the distilled patch).
        yield* domains
          .createOrTransferDomain({
            teamId,
            name: news.name,
            ...(news.zone !== false ? { zone: true } : {}),
            ...(news.cdnEnabled !== undefined
              ? { cdnEnabled: news.cdnEnabled }
              : {}),
          })
          .pipe(
            // A concurrent add of the same domain is a race, not a failure.
            Effect.catchTag("Conflict", () => Effect.void),
          );
      }
      // `zone`/`cdnEnabled` drift on an existing domain is handled by diff
      // (delete-first replacement) — re-adding does not update the flags.
      // Return — re-read the final state.
      const fresh = yield* observeDomain(news.name);
      if (fresh === undefined) {
        return yield* Effect.die(
          `Vercel domain ${news.name} not observable after add`,
        );
      }
      return fresh;
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      yield* domains
        .deleteDomain({ domain: output.name, teamId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
