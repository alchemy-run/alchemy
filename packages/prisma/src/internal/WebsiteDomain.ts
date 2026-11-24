import { adopt } from "alchemy/AdoptPolicy";
import * as DNS from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { ResourceLike } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Compute } from "../Compute.ts";
import { DomainOwnership } from "../DomainOwnership.ts";
import {
  RoutingUrl,
  type RoutingUrlInvalidHostname,
  type RoutingUrlInvalidProps,
} from "../RoutingUrl.ts";
import type { WebsiteDomain } from "../Website/FrameworkSite.ts";
import { coveringDomainsOf, type ProjectReference } from "./DomainOwnership.ts";
import { normalizeHostname } from "./Hostname.ts";
import { cnameTarget, requiredRecords } from "./RoutingUrlRequiredRecords.ts";

/** Id of the RoutingUrl a site declares for its custom hostname. */
export const WEBSITE_ROUTING_URL_ID = "Url";

/** Id of the domain ownership a site declares for its hostname when it is given none. */
export const WEBSITE_DOMAIN_OWNERSHIP_ID = "DomainOwnership";

/** Id under which releases before RoutingUrl published a site's `CNAME` through `dns.alias`. */
export const RELEASED_ALIAS_ID = "DomainAlias";

/** Id of the custom domain resource releases before RoutingUrl declared for a site. */
export const RELEASED_CUSTOM_DOMAIN_ID = "Domain";

/** A site's `domain.ownership` is for a domain that does not cover `domain.name`. */
export class WebsiteDomainOwnershipDoesNotCover extends Data.TaggedError(
  "WebsiteDomainOwnershipDoesNotCover",
)<{
  readonly message: string;
  readonly hostname: string;
  readonly ownershipDomain: string;
}> {}

/**
 * A site's hostname that a RoutingUrl cannot take is a mistake in the site's
 * configuration, so it stops the deploy as a defect while the stack is built,
 * as `DNS.resolve` does for a bad DNS configuration.
 */
const invalidConfiguration = <A, R>(
  effect: Effect.Effect<A, RoutingUrlInvalidHostname | RoutingUrlInvalidProps, R>,
): Effect.Effect<A, never, R> =>
  effect.pipe(
    Effect.catchTags({
      RoutingUrlInvalidHostname: (error) => Effect.die(error),
      RoutingUrlInvalidProps: (error) => Effect.die(error),
    }),
  );

type OwnershipState = Pick<
  DomainOwnership["Attributes"],
  "domain" | "status" | "expiresAt" | "recordName" | "recordValue"
>;

type NotVerified = Exclude<OwnershipState["status"], "verified">;

const doesNotCover = (hostname: string, ownershipDomain: string) => {
  const covering = coveringDomainsOf(hostname)
    .map((domain) => `'${domain}'`)
    .join(" or ");
  const apex = ownershipDomain === `*.${hostname}` ? " A wildcard does not cover its apex." : "";
  return new WebsiteDomainOwnershipDoesNotCover({
    hostname,
    ownershipDomain,
    message: `domain.ownership is the domain ownership of '${ownershipDomain}', which does not cover '${hostname}'. Pass one for ${covering}.${apex} Nothing was saved for '${hostname}'.`,
  });
};

/** What a domain ownership that is not verified means for the hostnames it covers. */
const notVerifiedWarning = (
  hostname: string,
  { domain, status, expiresAt, recordName, recordValue }: OwnershipState,
) => {
  const record = `TXT ${recordName} = ${recordValue}`;
  return status === "expiring"
    ? `The domain ownership of '${domain}' is expiring. Hostnames it covers, such as '${hostname}', that already serve keep serving until Prisma lapses it after ${expiresAt ?? "its expiry"}, and none starts serving, unless ${record} is published or another verified domain ownership covers them.`
    : `The domain ownership of '${domain}' is ${status}: it does not make hostnames it covers, such as '${hostname}', serve until Prisma finds ${record}, unless another verified domain ownership covers them.`;
};

/**
 * The site's app id, resolved only once `ownership` is saved and covers
 * `hostname`. Passed as `app` to every resource the site declares for the
 * hostname, it saves them after the domain ownership, so a serving site's
 * hostname change finds the new domain ownership and its `TXT` in place. It
 * logs once per deploy when `ownership`'s status is one of `warnsOn`.
 */
const appOnceOwned = (
  compute: Compute,
  ownership: DomainOwnership,
  hostname: string,
  warnsOn: ReadonlyArray<NotVerified>,
): Input<string> =>
  Output.mapEffect(
    ([appId, domain, status, expiresAt, recordName, recordValue]: [
      string,
      string,
      OwnershipState["status"],
      OwnershipState["expiresAt"],
      string,
      string,
    ]) => {
      const state = {
        domain: normalizeHostname(domain),
        status,
        expiresAt,
        recordName,
        recordValue,
      };
      if (!coveringDomainsOf(hostname).includes(state.domain)) {
        return Effect.die(doesNotCover(hostname, state.domain));
      }
      return status !== "verified" && warnsOn.includes(status)
        ? Effect.logWarning(notVerifiedWarning(hostname, state)).pipe(Effect.as(appId))
        : Effect.succeed(appId);
    },
  )(
    Output.all(
      compute.appId,
      ownership.domain,
      ownership.status,
      ownership.expiresAt,
      ownership.recordName,
      ownership.recordValue,
    ),
  );

/**
 * The site's custom hostname: a RoutingUrl, with its records published
 * through `domain.dns`, and the domain ownership that covers it, the one
 * passed as `domain.ownership` or one the site declares.
 */
export const websiteDomain = Effect.fn(function* (
  domain: WebsiteDomain,
  compute: Compute,
  project: Input<ProjectReference>,
) {
  const hostname = typeof domain === "string" ? domain : domain.name;
  const dns = typeof domain === "object" ? domain.dns : undefined;
  const passed = typeof domain === "object" ? domain.ownership : undefined;
  const ownership =
    passed ??
    (yield* DomainOwnership(WEBSITE_DOMAIN_OWNERSHIP_ID, {
      project,
      domain: hostname,
      ...(dns === undefined ? {} : { dns }),
    }));
  // The site's own domain ownership is unverified on a first deploy, which the
  // RoutingUrl's state already reports; an expiring one, such as an adopted
  // backfilled row without `dns`, would otherwise stop serving unannounced.
  const app = appOnceOwned(
    compute,
    ownership,
    normalizeHostname(hostname),
    passed === undefined ? ["expiring"] : ["unverified", "expiring"],
  );
  if (dns === undefined) {
    const url = yield* RoutingUrl(WEBSITE_ROUTING_URL_ID, { app, hostname }).pipe(
      invalidConfiguration,
    );
    return { url, ownership };
  }
  const url = yield* RoutingUrl(WEBSITE_ROUTING_URL_ID, { app, hostname, dns }).pipe(
    invalidConfiguration,
  );
  const required = yield* requiredRecords(WEBSITE_ROUTING_URL_ID, app, normalizeHostname(hostname));
  // Sites deployed before this release published their CNAME through this
  // alias, so it stays declared to keep that record through their upgrade,
  // and can be removed once they have all redeployed with this release.
  // Adopted, because on Cloudflare the record set has already published this
  // CNAME and the alias would otherwise refuse it as someone else's; retained,
  // so only the record set ever deletes the CNAME.
  const { proxied: _proxied, ...options } = dns.options ?? {};
  yield* (yield* DNS.resolve({ ...dns, options }))
    .alias(RELEASED_ALIAS_ID, {
      name: hostname,
      target: {
        hostname: Output.map(
          Output.all(Output.of(url as ResourceLike), required.records),
          ([, records]) => cnameTarget(records),
        ),
      },
    })
    .pipe(adopt(true), RemovalPolicy.retain());
  return { url, ownership };
});
