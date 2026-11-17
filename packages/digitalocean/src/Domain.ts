import * as DO from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";

export type DomainProps = {
  /**
   * The domain name, for example `"example.com"` or a subdomain such as
   * `"internal.example.com"`. Point the domain's NS records at
   * `ns1.digitalocean.com`, `ns2.digitalocean.com` and `ns3.digitalocean.com`
   * at your registrar. A change replaces the domain and all its records.
   */
  name: string;
};

export type Domain = Resource<
  "DigitalOcean.Domain",
  DomainProps,
  {
    /** The domain name. */
    name: string;
    /** Uniform resource name, `do:domain:<name>`, for `ProjectResources`. */
    urn: string;
    /** Default TTL of the domain's records, in seconds. */
    ttl: number | undefined;
    /** The zone file DigitalOcean serves for the domain. */
    zoneFile: string | undefined;
  },
  never,
  Providers
>;

/**
 * A domain hosted on DigitalOcean DNS. DigitalOcean creates its SOA and NS
 * records; add the rest with `DomainRecord`. Destroying the domain deletes
 * every record in it.
 *
 * A domain has no tags. Alchemy owns a domain it recorded; one that
 * already exists on the team is `Unowned` and needs `--adopt`.
 *
 * ### Hosting a Domain
 * **Example:** A domain with an apex record
 * ```typescript
 * const domain = yield* DigitalOcean.Domain("example", { name: "example.com" });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 * });
 * yield* DigitalOcean.DomainRecord("apex", {
 *   domain: domain.name,
 *   type: "A",
 *   name: "@",
 *   data: host.ipv4,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Domains
 *
 * @resource
 * @product Domains
 * @category Networking
 */
export const Domain = Resource<Domain>("DigitalOcean.Domain");

export class DomainWaitTimedOut extends Data.TaggedError("DigitalOcean.DomainWaitTimedOut")<{
  readonly domainName: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `Domain ${this.domainName} timed out waiting for ${this.waitingFor}.`;
  }
}

// GET lags a change by a few seconds.
const DOMAIN_POLL: PollBudget = { maxDelay: "3 seconds", times: 20 };

const toAttrs = (domain: DO.DomainOutput) => ({
  name: domain.name,
  urn: `do:domain:${domain.name}`,
  ttl: domain.ttl ?? undefined,
  zoneFile: domain.zone_file || undefined,
});

const observe = (name: string) =>
  noneIfNotFound(DO.getDomain({ domain_name: name }).pipe(Effect.map((r) => r.domain)));

const waitUntilGone = (name: string) =>
  pollUntil(observe(name), {
    ...DOMAIN_POLL,
    until: Option.isNone,
    onTimeout: () => new DomainWaitTimedOut({ domainName: name, waitingFor: "deletion" }),
  });

export const DomainProvider = () =>
  Provider.succeed(Domain, {
    stables: ["name", "urn"],
    // A domain carries no ownership marker.
    nuke: { skip: true },
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(output?.name ?? olds.name);
      if (Option.isNone(observed)) return undefined;
      const attrs = toAttrs(observed.value);
      return output === undefined ? Unowned(attrs) : attrs;
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.name !== olds.name) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const observed = yield* observe(news.name);
      const domain = yield* Option.match(observed, {
        onNone: () =>
          DO.createDomain({ name: news.name }).pipe(Effect.map((response) => response.domain)),
        onSome: Effect.succeed,
      });
      return toAttrs(domain);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteDomain({ domain_name: output.name }));
      yield* waitUntilGone(output.name);
    }),
  });
