import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  listProjectDataStores,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  parseResourceName,
  sameStringList,
  servingConfigIdOf,
  toPhysical,
} from "./internal.ts";

export type CollectionsDataStoresServingConfigProps = {
  /**
   * Parent data store resource name. Immutable — changing it replaces
   * the serving config.
   */
  dataStore: string;
  /**
   * Serving config id (4-63 characters, `[a-zA-Z0-9_]`). If omitted, a
   * unique id is generated. Immutable — changing it replaces the serving
   * config.
   */
  servingConfigId?: string;
  /**
   * Human-readable name (max 128 characters). Serving configs have no
   * labels field, so Alchemy stamps ownership into this field for
   * `list` / nuke.
   */
  displayName?: string;
  /**
   * Solution type. Immutable.
   * @default "SOLUTION_TYPE_SEARCH"
   */
  solutionType?:
    | "SOLUTION_TYPE_UNSPECIFIED"
    | "SOLUTION_TYPE_RECOMMENDATION"
    | "SOLUTION_TYPE_SEARCH"
    | "SOLUTION_TYPE_CHAT"
    | "SOLUTION_TYPE_GENERATIVE_CHAT"
    | "SOLUTION_TYPE_AI_MODE"
    | (string & {});
  /**
   * Filter control ids applied at serving time.
   */
  filterControlIds?: string[];
  /**
   * Boost control ids applied at serving time.
   */
  boostControlIds?: string[];
  /**
   * Redirect control ids.
   */
  redirectControlIds?: string[];
  /**
   * Synonyms control ids.
   */
  synonymsControlIds?: string[];
  /**
   * Ranking expression, e.g. `0.5 * relevance_score`.
   */
  rankingExpression?: string;
  /**
   * Recommendation diversity level.
   */
  diversityLevel?: string;
  /**
   * Recommendation model id. Required for `SOLUTION_TYPE_RECOMMENDATION`.
   */
  modelId?: string;
};

export type CollectionsDataStoresServingConfig = Resource<
  "GCP.Discoveryengine.CollectionsDataStoresServingConfig",
  CollectionsDataStoresServingConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Serving config id. */
    servingConfigId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Solution type. */
    solutionType: string | undefined;
    /** Filter control ids. */
    filterControlIds: string[];
    /** Boost control ids. */
    boostControlIds: string[];
    /** Redirect control ids. */
    redirectControlIds: string[];
    /** Synonyms control ids. */
    synonymsControlIds: string[];
    /** Ranking expression. */
    rankingExpression: string | undefined;
    /** Diversity level. */
    diversityLevel: string | undefined;
    /** Model id. */
    modelId: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine serving config on a collection data store.
 *
 * Serving configs have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent, serving config id, and solution
 * type are immutable. Display name and control-id lists update in place.
 *
 * ### Creating a Serving Config
 * **Example:** Extra search serving config
 * ```typescript
 * const store = yield* GCP.Discoveryengine.CollectionsDataStore("Docs", {});
 * const serving = yield* GCP.Discoveryengine.CollectionsDataStoresServingConfig(
 *   "Preview",
 *   {
 *     dataStore: store.name,
 *     displayName: "preview search",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsDataStoresServingConfig =
  Resource<CollectionsDataStoresServingConfig>(
    "GCP.Discoveryengine.CollectionsDataStoresServingConfig",
  );

export class CollectionsDataStoresServingConfigNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsDataStoresServingConfigNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  config: discoveryengine.GoogleCloudDiscoveryengineV1ServingConfig,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name, "servingConfigs");
  const ownership = parseOwnership(config.displayName);
  return {
    name,
    servingConfigId: parsed.id,
    dataStore: parentOf(name, "servingConfigs"),
    project: parsed.project || project,
    location: parsed.location,
    displayName: ownership.text,
    solutionType: config.solutionType,
    filterControlIds: [...(config.filterControlIds ?? [])],
    boostControlIds: [...(config.boostControlIds ?? [])],
    redirectControlIds: [...(config.redirectControlIds ?? [])],
    synonymsControlIds: [...(config.synonymsControlIds ?? [])],
    rankingExpression: config.rankingExpression,
    diversityLevel: config.diversityLevel,
    modelId: config.modelId,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const resourceName = (dataStore: string, servingConfigId: string) =>
  `${dataStore}/servingConfigs/${servingConfigId}`;

const toBody = (
  news: CollectionsDataStoresServingConfigProps,
  displayName: string,
): discoveryengine.GoogleCloudDiscoveryengineV1ServingConfig => ({
  displayName,
  solutionType: news.solutionType ?? "SOLUTION_TYPE_SEARCH",
  filterControlIds: news.filterControlIds,
  boostControlIds: news.boostControlIds,
  redirectControlIds: news.redirectControlIds,
  synonymsControlIds: news.synonymsControlIds,
  rankingExpression: news.rankingExpression,
  diversityLevel: news.diversityLevel,
  modelId: news.modelId,
});

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresServingConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsCollectionsDataStoresServingConfigs
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.servingConfigs ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const findOwned = (id: string, dataStore: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const configs = yield* listAtParent(dataStore);
    for (const config of configs) {
      if (yield* ownedByAlchemy(id, config.displayName)) return config;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1ServingConfig
      | undefined;
  });

export const CollectionsDataStoresServingConfigProvider = () =>
  Provider.succeed(CollectionsDataStoresServingConfig, {
    stables: [
      "name",
      "servingConfigId",
      "dataStore",
      "project",
      "location",
      "solutionType",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousId = olds?.servingConfigId ?? output?.servingConfigId;
      const previousType = olds?.solutionType ?? output?.solutionType;
      const nextType = news.solutionType ?? previousType;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        (previousId !== undefined &&
          news.servingConfigId !== undefined &&
          news.servingConfigId !== previousId) ||
        (previousType !== undefined &&
          nextType !== undefined &&
          previousType !== nextType)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === news.dataStore &&
            previousId !== undefined &&
            news.servingConfigId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataStore = olds?.dataStore ?? output?.dataStore;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : dataStore !== undefined
            ? yield* findOwned(id, dataStore)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listProjectDataStores(env.project);
        const pages = yield* Effect.forEach(
          stores,
          (store) =>
            store.name
              ? listAtParent(store.name).pipe(
                  Effect.map((configs) =>
                    configs
                      .filter(
                        (config) =>
                          Object.keys(parseOwnership(config.displayName).labels)
                            .length > 0,
                      )
                      .map((config) => toAttrs(config, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const servingConfigId = yield* toPhysical(
        id,
        news.servingConfigId,
        output?.servingConfigId,
        servingConfigIdOf,
      );
      const name = resourceName(news.dataStore, servingConfigId);
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName ?? servingConfigId,
      );
      const body = toBody(news, displayName);

      let current = yield* findOwned(id, news.dataStore, output?.name);
      if (current === undefined) {
        current = yield* getByName(name);
      }

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresServingConfigs({
            parent: news.dataStore,
            servingConfigId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresServingConfigNotResolved({
          name,
        });
      }

      const resource = current.name ?? name;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const filterChanged = !sameStringList(
        current.filterControlIds,
        news.filterControlIds,
      );
      const boostChanged = !sameStringList(
        current.boostControlIds,
        news.boostControlIds,
      );
      const redirectChanged = !sameStringList(
        current.redirectControlIds,
        news.redirectControlIds,
      );
      const synonymsChanged = !sameStringList(
        current.synonymsControlIds,
        news.synonymsControlIds,
      );
      const rankingChanged =
        (current.rankingExpression ?? "") !== (news.rankingExpression ?? "");
      const diversityChanged =
        (current.diversityLevel ?? "") !== (news.diversityLevel ?? "");
      const modelChanged = (current.modelId ?? "") !== (news.modelId ?? "");

      if (
        displayNameChanged ||
        filterChanged ||
        boostChanged ||
        redirectChanged ||
        synonymsChanged ||
        rankingChanged ||
        diversityChanged ||
        modelChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresServingConfigs(
            {
              name: resource,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                filterChanged ? "filter_control_ids" : undefined,
                boostChanged ? "boost_control_ids" : undefined,
                redirectChanged ? "redirect_control_ids" : undefined,
                synonymsChanged ? "synonyms_control_ids" : undefined,
                rankingChanged ? "ranking_expression" : undefined,
                diversityChanged ? "diversity_level" : undefined,
                modelChanged ? "model_id" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: { ...body, name: resource },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresServingConfigs({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
