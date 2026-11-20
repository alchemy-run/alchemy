import { adopt } from "alchemy/AdoptPolicy";
import * as DNS from "alchemy/DNS/Adapter";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Compute } from "../Compute.ts";
import {
  RoutingUrl,
  type RoutingUrlInvalidHostname,
  type RoutingUrlInvalidProps,
} from "../RoutingUrl.ts";
import type { WebsiteDomain } from "../Website/FrameworkSite.ts";
import { normalizeHostname } from "./Hostname.ts";
import { cnameTarget, requiredRecords } from "./RoutingUrlRequiredRecords.ts";

/** Id of the RoutingUrl a site declares for its custom hostname. */
export const WEBSITE_ROUTING_URL_ID = "Url";

/** Id under which releases before RoutingUrl published a site's `CNAME` through `dns.alias`. */
export const RELEASED_ALIAS_ID = "DomainAlias";

/** Id of the custom domain resource releases before RoutingUrl declared for a site. */
export const RELEASED_CUSTOM_DOMAIN_ID = "Domain";

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

/** The site's custom hostname: a RoutingUrl, with its records published through `domain.dns`. */
export const websiteDomain = Effect.fn(function* (domain: WebsiteDomain, compute: Compute) {
  const hostname = typeof domain === "string" ? domain : domain.name;
  const dns = typeof domain === "object" ? domain.dns : undefined;
  if (dns === undefined) {
    return yield* RoutingUrl(WEBSITE_ROUTING_URL_ID, { app: compute, hostname }).pipe(
      invalidConfiguration,
    );
  }
  const url = yield* RoutingUrl(WEBSITE_ROUTING_URL_ID, { app: compute, hostname, dns }).pipe(
    invalidConfiguration,
  );
  const required = yield* requiredRecords(
    WEBSITE_ROUTING_URL_ID,
    compute,
    normalizeHostname(hostname),
  );
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
  return url;
});
