import * as DO from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import type { Providers } from "./Providers.ts";

export type RegistryTier = "starter" | "basic" | "professional";

export type RegistryProps = {
  /**
   * Registry name: 3 to 63 lowercase letters, digits and `-`, unique across
   * DigitalOcean. Images are pushed to `registry.digitalocean.com/<name>`.
   * A change replaces the registry and deletes its images.
   */
  name: string;
  /**
   * Subscription tier. `starter` is free (one repository, 500 MiB);
   * `basic` and `professional` are billed monthly. A change updates the
   * team's subscription in place.
   *
   * @default "starter"
   */
  tier?: RegistryTier;
  /** Region that stores the images. A change replaces the registry. @default "nyc3" */
  region?: "nyc3" | "sfo3" | "sfo2" | "ams3" | "sgp1" | "fra1" | "blr1" | "syd1";
};

export type Registry = Resource<
  "DigitalOcean.Registry",
  RegistryProps,
  {
    /** Registry name. */
    name: string;
    /** Host and path images are pushed to, `registry.digitalocean.com/<name>`. */
    endpoint: string;
    /** Region that stores the images. */
    region: string | undefined;
    /** Subscription tier slug. */
    tier: string | undefined;
    /** Bytes stored. */
    storageUsageBytes: number | undefined;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type RegistryAttributes = Registry["Attributes"];

/**
 * The DigitalOcean Container Registry: a private Docker registry for the
 * team. A team has one registry, so a stack should declare it once.
 * `tier` updates the team's subscription in place; `name` and `region`
 * replace the registry, deleting every image in it.
 *
 * Alchemy owns a registry it recorded; a registry that already exists on
 * the team is `Unowned` and needs `--adopt`.
 *
 * ### Creating a Registry
 * **Example:** The free starter tier
 * ```typescript
 * const registry = yield* DigitalOcean.Registry("registry", { name: "acme" });
 * // docker push registry.digitalocean.com/acme/app:latest
 * ```
 *
 * **Example:** More repositories on the basic tier
 * ```typescript
 * const registry = yield* DigitalOcean.Registry("registry", {
 *   name: "acme",
 *   tier: "basic",
 *   region: "fra1",
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Container-Registry
 *
 * @resource
 * @product Container Registry
 * @category Containers
 */
export const Registry = Resource<Registry>("DigitalOcean.Registry");

const observe = (name: string) =>
  noneIfNotFound(DO.getRegistry({ registry_name: name }).pipe(Effect.map((r) => r.registry)));

const currentTier = DO.getRegistrySubscription({}).pipe(
  Effect.map((r) => r.subscription.tier.slug),
  Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
);

const toAttrs = (registry: DO.RegistryBase, tier: string | undefined): RegistryAttributes => ({
  name: registry.name,
  endpoint: `registry.digitalocean.com/${registry.name}`,
  region: registry.region || undefined,
  tier,
  storageUsageBytes: registry.storage_usage_bytes ?? undefined,
  createdAt: registry.created_at,
});

export const RegistryProvider = () =>
  Provider.succeed(Registry, {
    stables: ["name", "endpoint", "region", "createdAt"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(output?.name ?? olds.name);
      if (Option.isNone(observed)) return undefined;
      const attrs = toAttrs(observed.value, yield* currentTier);
      return output === undefined ? Unowned(attrs) : attrs;
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.name !== olds.name || (news.region ?? "nyc3") !== (olds.region ?? "nyc3")) {
        // A team holds one registry, so the old one goes first.
        return { action: "replace", deleteFirst: true } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const tier = news.tier ?? "starter";
      const observed = yield* observe(news.name);
      const registry = yield* Option.match(observed, {
        onNone: () =>
          DO.createRegistry({
            name: news.name,
            subscription_tier_slug: tier,
            region: news.region ?? "nyc3",
          }).pipe(Effect.map((r) => r.registry)),
        onSome: Effect.succeed,
      });
      if ((yield* currentTier) !== tier) {
        yield* DO.updateRegistrySubscription({ tier_slug: tier });
      }
      return toAttrs(registry, tier);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteRegistry({ registry_name: output.name }));
    }),
  });
