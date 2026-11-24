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
import type { ProjectReference } from "./DomainOwnership.ts";
import { normalizeHostname, wildcardOf } from "./Hostname.ts";
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
export class WebsiteDomainOwnershipMismatch extends Data.TaggedError(
  "WebsiteDomainOwnershipMismatch",
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

const covers = (ownershipDomain: string, hostname: string) =>
  ownershipDomain === hostname || ownershipDomain === wildcardOf(hostname);

/**
 * The site's app id, resolved only once `ownership` is saved and covers
 * `hostname`. Passed as `app` to every resource the site declares for the
 * hostname, it saves them after the domain ownership, so a serving site's
 * hostname change finds the new domain ownership and its `TXT` in place.
 */
const appOnceOwned = (
  compute: Compute,
  ownership: DomainOwnership,
  hostname: string,
  managedElsewhere: boolean,
): Input<string> =>
  Output.mapEffect(
    ([appId, domain, status]: [string, string, DomainOwnership["Attributes"]["status"]]) => {
      const ownershipDomain = normalizeHostname(domain);
      if (!covers(ownershipDomain, hostname)) {
        return Effect.die(
          new WebsiteDomainOwnershipMismatch({
            hostname,
            ownershipDomain,
            message: `domain.ownership is the domain ownership of '${ownershipDomain}', which does not cover '${hostname}'. Pass one for '${hostname}'${wildcardOf(hostname) === undefined ? "" : ` or '${wildcardOf(hostname)}'`}; a wildcard does not cover its apex. Nothing was saved for '${hostname}'.`,
          }),
        );
      }
      return managedElsewhere && status !== "verified"
        ? Effect.logWarning(
            `The domain ownership of '${ownershipDomain}' is ${status}, so '${hostname}' serves only once Prisma verifies it.`,
          ).pipe(Effect.as(appId))
        : Effect.succeed(appId);
    },
  )(Output.all(compute.appId, ownership.domain, ownership.status));

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
  const app = appOnceOwned(compute, ownership, normalizeHostname(hostname), passed !== undefined);
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
