import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createRegistryName,
  registryOwnedByStage,
  sameName,
} from "./Common.ts";

export interface CacheRuleProps {
  /** Resource group of the registry. Changing it replaces the cache rule. */
  resourceGroup: string;
  /** Registry that holds the cache rule. Changing it replaces the cache rule. */
  registry: string;
  /**
   * Cache rule name: 5-50 letters, digits, hyphens, and underscores. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the cache rule.
   */
  name?: string;
  /**
   * Upstream repository to cache, e.g. `mcr.microsoft.com/hello-world` or
   * `docker.io/library/nginx` (a trailing `/*` caches a whole namespace).
   * Changing it replaces the cache rule.
   */
  sourceRepository: string;
  /**
   * Repository in this registry that serves the cached images, e.g.
   * `hello-world`. Changing it replaces the cache rule.
   */
  targetRepository: string;
  /**
   * ARM resource ID of a `CredentialSet` used to authenticate to the
   * upstream registry. Omit for anonymous upstream pulls.
   */
  credentialSetResourceId?: string;
}

export interface CacheRule extends Resource<
  "Azure.ContainerRegistry.CacheRule",
  CacheRuleProps,
  {
    /** Name of the cache rule. */
    cacheRuleName: string;
    /** ARM resource ID of the cache rule. */
    cacheRuleId: string;
    /** Registry that holds the cache rule. */
    registry: string;
    /** Resource group of the registry. */
    resourceGroup: string;
    /** Upstream repository. */
    sourceRepository: string;
    /** Repository in this registry. */
    targetRepository: string;
    /** Credential set used for the upstream, if any. */
    credentialSetResourceId: string | undefined;
    /** Creation date (ISO 8601). */
    creationDate: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An artifact cache rule — pulls through `{registry}/{targetRepository}`
 * transparently fetch and cache images from an upstream registry.
 *
 * Cache rules have no tags; Alchemy treats one as owned when its registry
 * carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/container-registry/artifact-cache-overview
 *
 * ### Caching an Upstream Repository
 * **Example:** Cache a public MCR image
 * ```typescript
 * const rule = yield* Azure.ContainerRegistry.CacheRule("hello", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   sourceRepository: "mcr.microsoft.com/hello-world",
 *   targetRepository: "hello-world",
 * });
 * // docker pull <loginServer>/hello-world:latest
 * ```
 *
 * **Example:** Authenticated Docker Hub cache
 * ```typescript
 * const rule = yield* Azure.ContainerRegistry.CacheRule("nginx", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   sourceRepository: "docker.io/library/nginx",
 *   targetRepository: "nginx",
 *   credentialSetResourceId: dockerHub.credentialSetId,
 * });
 * ```
 *
 * @resource
 */
export const CacheRule = Resource<CacheRule>(
  "Azure.ContainerRegistry.CacheRule",
);

const getCacheRule = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
  cacheRuleName: string,
) =>
  orUndefinedIfNotFound(
    containerregistry.GetCacheRule({
      subscriptionId,
      resourceGroupName,
      registryName,
      cacheRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  registry: string,
  name: string,
  rule: containerregistry.GetCacheRuleResponse,
): CacheRule["Attributes"] => ({
  cacheRuleName: name,
  cacheRuleId: rule.id ?? "",
  registry,
  resourceGroup,
  sourceRepository: rule.properties?.sourceRepository ?? "",
  targetRepository: rule.properties?.targetRepository ?? "",
  credentialSetResourceId: rule.properties?.credentialSetResourceId,
  creationDate: rule.properties?.creationDate,
});

export const CacheRuleProvider = () =>
  Provider.succeed(CacheRule, {
    stables: ["cacheRuleName", "cacheRuleId", "registry", "resourceGroup"],

    // Cache rules live inside a registry; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.registry, output.registry) ||
        (news.name !== undefined &&
          !sameName(news.name, output.cacheRuleName)) ||
        news.sourceRepository !== output.sourceRepository ||
        news.targetRepository !== output.targetRepository
      ) {
        // A kept explicit name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined &&
            sameName(news.name, output.cacheRuleName),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const registry = output?.registry ?? olds?.registry;
      if (resourceGroup === undefined || registry === undefined) {
        return undefined;
      }
      const name =
        output?.cacheRuleName ?? olds?.name ?? (yield* createRegistryName(id));
      const observed = yield* getCacheRule(
        subscriptionId,
        resourceGroup,
        registry,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, registry, name, observed);
      return (yield* registryOwnedByStage(
        subscriptionId,
        resourceGroup,
        registry,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerRegistry");
      const { resourceGroup, registry } = news;
      const name =
        news.name ?? output?.cacheRuleName ?? (yield* createRegistryName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: registry,
        cacheRuleName: name,
      };
      const get = getCacheRule(subscriptionId, resourceGroup, registry, name);
      const waitReady = waitForProvisioned(
        `cache rule ${name}`,
        get,
        (rule) => rule.properties?.provisioningState,
        { interval: "2 seconds", times: 30 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* containerregistry.CreateCacheRule({
          ...where,
          properties: {
            sourceRepository: news.sourceRepository,
            targetRepository: news.targetRepository,
            credentialSetResourceId: news.credentialSetResourceId,
          },
        });
      }
      observed = yield* waitReady;

      // Sync the credential set against the observed rule.
      if (
        !sameName(
          observed.properties?.credentialSetResourceId || undefined,
          news.credentialSetResourceId || undefined,
        )
      ) {
        yield* containerregistry.UpdateCacheRule({
          ...where,
          properties: {
            // An empty string detaches the credential set.
            credentialSetResourceId: news.credentialSetResourceId ?? "",
          },
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, registry, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        containerregistry.DeleteCacheRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          registryName: output.registry,
          cacheRuleName: output.cacheRuleName,
        }),
      );
      yield* waitUntilGone(
        `cache rule ${output.cacheRuleName}`,
        getCacheRule(
          subscriptionId,
          output.resourceGroup,
          output.registry,
          output.cacheRuleName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerRegistry.Registry",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
