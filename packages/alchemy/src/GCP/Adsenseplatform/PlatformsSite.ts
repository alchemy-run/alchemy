import * as adsenseplatform from "@distilled.cloud/gcp/adsenseplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDomain,
  findOwnedSite,
  findSiteByDomain,
  getSite,
  hasOwnershipMarker,
  ignoreMissing,
  lastSegment,
  listOwnedSites,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseDomain,
  replaceOnIdentity,
  resourceName,
  toParent,
  toUserDomain,
} from "./internal.ts";

export type PlatformsSiteProps = {
  /**
   * Parent platform account. Full name
   * `platforms/{platform}/accounts/{account}`. Immutable — changing it
   * replaces the site.
   */
  parent: string;
  /**
   * Domain/sub-domain of the site (RFC 1035, punycode). Immutable —
   * changing it replaces the site. If omitted, a unique
   * `{name}.alchemy-gcp-testing.com` domain is generated. Sites have no
   * labels field, so Alchemy stamps ownership into an `alch.{stack}.{stage}.{id}.`
   * prefix and strips it from attributes.
   */
  domain?: string;
};

export type PlatformsSite = Resource<
  "GCP.Adsenseplatform.PlatformsSite",
  PlatformsSiteProps,
  {
    /** Full resource name `platforms/{platform}/accounts/{account}/sites/{site}`. */
    name: string;
    /** Site id (last path segment). */
    siteId: string;
    /** Parent platform account resource name. */
    parent: string;
    /** Project id used when the site was reconciled. */
    project: string;
    /** User-facing domain with the Alchemy ownership prefix stripped. */
    domain: string | undefined;
    /** Review state (`REQUIRES_REVIEW`, `GETTING_READY`, `READY`, `NEEDS_ATTENTION`). */
    state: string | undefined;
  },
  never,
  Providers
>;

/**
 * An AdSense for Platforms site
 * (`platforms/{platform}/accounts/{account}/sites/{site}`).
 *
 * Sites have no labels field, so Alchemy stamps ownership into `domain`
 * as `alch.{stack}.{stage}.{id}.{domain}` for `list` / nuke. Parent
 * account and domain are identity — changing either replaces the site.
 * There is no update API.
 *
 * ### Creating a Site
 * **Example:** Generated domain
 * ```typescript
 * const site = yield* GCP.Adsenseplatform.PlatformsSite("Blog", {
 *   parent: "platforms/pub-123/accounts/pub-456",
 * });
 * ```
 *
 * **Example:** Explicit domain
 * ```typescript
 * const site = yield* GCP.Adsenseplatform.PlatformsSite("Blog", {
 *   parent: "platforms/pub-123/accounts/pub-456",
 *   domain: "example.com",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Adsenseplatform
 */
export const PlatformsSite = Resource<PlatformsSite>(
  "GCP.Adsenseplatform.PlatformsSite",
);

export class PlatformsSiteNotResolved extends Data.TaggedError(
  "GCP.Adsenseplatform.PlatformsSiteNotResolved",
)<{
  parent: string;
  name: string;
}> {}

const lookupName = (
  parent: string,
  siteId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName && existingName.length > 0) return existingName;
  if (siteId && siteId.length > 0 && parent.length > 0) {
    return resourceName(parent, siteId);
  }
  return "";
};

const toAttrs = (row: adsenseplatform.Site, project: string) => {
  const name = row.name ?? "";
  return {
    name,
    siteId: lastSegment(name),
    parent: parentOf(name),
    project,
    domain: parseDomain(row.domain).domain,
    state: row.state,
  };
};

export const PlatformsSiteProvider = () =>
  Provider.succeed(PlatformsSite, {
    stables: ["name", "siteId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: toParent(news.parent),
        previousDomain: olds?.domain ?? output?.domain,
        nextDomain: news.domain,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toParent(olds?.parent ?? output?.parent ?? "");
      const name = lookupName(parent, output?.siteId, output?.name);
      let existing = yield* getSite(name);
      if (existing === undefined) {
        existing = yield* findOwnedSite(id, parent);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.domain))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const sites = yield* listOwnedSites();
        return sites
          .filter((site) => hasOwnershipMarker(site.domain))
          .map((site) => toAttrs(site, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toParent(news.parent);
      const ownership = yield* ownershipLabels(id);
      const userDomain = yield* toUserDomain(id, news.domain, output?.domain);
      const domain = encodeDomain(ownership, userDomain);
      const name = lookupName(parent, output?.siteId, output?.name);

      let current = yield* getSite(name);
      if (current === undefined) {
        current = yield* findOwnedSite(id, parent);
      }
      if (current === undefined) {
        current = yield* findSiteByDomain(domain, parent);
      }

      if (current === undefined) {
        const created = yield* adsenseplatform
          .createPlatformsAccountsSites({
            parent,
            body: { domain },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findSiteByDomain(domain, parent)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PlatformsSiteNotResolved({
          parent,
          name: name || domain,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreMissing(
        adsenseplatform.deletePlatformsAccountsSites({ name: output.name }),
      );
    }),
  });
