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
  sameSet,
} from "./Common.ts";

export interface ScopeMapProps {
  /** Resource group of the registry. Changing it replaces the scope map. */
  resourceGroup: string;
  /** Registry that holds the scope map. Changing it replaces the scope map. */
  registry: string;
  /**
   * Scope map name: 5-50 letters, digits, hyphens, and underscores. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the scope map.
   */
  name?: string;
  /** Human-readable description. */
  description?: string;
  /**
   * Repository permissions granted to tokens using this scope map, e.g.
   * `repositories/app/content/read`, `repositories/app/content/write`,
   * `repositories/app/metadata/read`.
   */
  actions: string[];
}

export interface ScopeMap extends Resource<
  "Azure.ContainerRegistry.ScopeMap",
  ScopeMapProps,
  {
    /** Name of the scope map. */
    scopeMapName: string;
    /** ARM resource ID of the scope map; pass it to a `Token`. */
    scopeMapId: string;
    /** Registry that holds the scope map. */
    registry: string;
    /** Resource group of the registry. */
    resourceGroup: string;
    /** Repository permissions granted by the scope map. */
    actions: string[];
    /** Description of the scope map. */
    description: string | undefined;
    /** Creation date (ISO 8601). */
    creationDate: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A container registry scope map — a named set of repository permissions
 * that registry `Token`s are bound to.
 *
 * Scope maps have no tags; Alchemy treats one as owned when its registry
 * carries this stack's ownership tags. Built-in system scope maps
 * (`_repositories_pull`, ...) are never managed.
 *
 * @see https://learn.microsoft.com/azure/container-registry/container-registry-repository-scoped-permissions
 *
 * ### Creating a Scope Map
 * **Example:** Read/write access to one repository
 * ```typescript
 * const scope = yield* Azure.ContainerRegistry.ScopeMap("app-push", {
 *   resourceGroup: group.resourceGroupName,
 *   registry: registry.registryName,
 *   actions: [
 *     "repositories/app/content/read",
 *     "repositories/app/content/write",
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ScopeMap = Resource<ScopeMap>("Azure.ContainerRegistry.ScopeMap");

const getScopeMap = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
  scopeMapName: string,
) =>
  orUndefinedIfNotFound(
    containerregistry.GetScopeMap({
      subscriptionId,
      resourceGroupName,
      registryName,
      scopeMapName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  registry: string,
  name: string,
  scopeMap: containerregistry.GetScopeMapResponse,
): ScopeMap["Attributes"] => ({
  scopeMapName: name,
  scopeMapId: scopeMap.id ?? "",
  registry,
  resourceGroup,
  actions: [...(scopeMap.properties?.actions ?? [])],
  description: scopeMap.properties?.description,
  creationDate: scopeMap.properties?.creationDate,
});

export const ScopeMapProvider = () =>
  Provider.succeed(ScopeMap, {
    stables: ["scopeMapName", "scopeMapId", "registry", "resourceGroup"],

    // Scope maps live inside a registry; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.registry, output.registry) ||
        (news.name !== undefined && !sameName(news.name, output.scopeMapName))
      ) {
        // A kept explicit name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined && sameName(news.name, output.scopeMapName),
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
        output?.scopeMapName ?? olds?.name ?? (yield* createRegistryName(id));
      const observed = yield* getScopeMap(
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
        news.name ?? output?.scopeMapName ?? (yield* createRegistryName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: registry,
        scopeMapName: name,
      };
      const get = getScopeMap(subscriptionId, resourceGroup, registry, name);
      const waitReady = waitForProvisioned(
        `scope map ${name}`,
        get,
        (scopeMap) => scopeMap.properties?.provisioningState,
        { interval: "2 seconds", times: 30 },
      );

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* containerregistry.CreateScopeMap({
          ...where,
          properties: { description: news.description, actions: news.actions },
        });
      } else {
        // Sync description and actions against the observed scope map.
        const actionsChanged = !sameSet(
          observed.properties?.actions,
          news.actions,
        );
        const descriptionChanged =
          news.description !== undefined &&
          news.description !== observed.properties?.description;
        if (actionsChanged || descriptionChanged) {
          yield* containerregistry.UpdateScopeMap({
            ...where,
            properties: {
              description: descriptionChanged ? news.description : undefined,
              actions: actionsChanged ? news.actions : undefined,
            },
          });
        }
      }

      const fresh = yield* waitReady;
      return toAttrs(resourceGroup, registry, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        containerregistry.DeleteScopeMap({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          registryName: output.registry,
          scopeMapName: output.scopeMapName,
        }),
      );
      yield* waitUntilGone(
        `scope map ${output.scopeMapName}`,
        getScopeMap(
          subscriptionId,
          output.resourceGroup,
          output.registry,
          output.scopeMapName,
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
