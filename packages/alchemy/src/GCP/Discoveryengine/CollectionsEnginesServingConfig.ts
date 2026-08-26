import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  hasOwnershipMarker,
  listEngines,
  ownershipLabels,
  parentBefore,
  parseOwnership,
  parseResourceName,
  sameStringList,
  servingConfigId,
} from "./internal.ts";

export type CollectionsEnginesServingConfigProps = {
  /**
   * Parent Engine resource name
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   * Immutable — changing it replaces the serving config.
   */
  engine: string;
  /**
   * Serving config id (4-63 alphanumeric characters). If omitted, a
   * unique id is generated. Immutable — changing it replaces the
   * serving config.
   */
  servingConfigId?: string;
  /**
   * Human-readable name (max 128 characters). Serving configs have no
   * labels field, so Alchemy stamps ownership into this field for list /
   * nuke.
   */
  displayName?: string;
  /**
   * Solution type. Immutable.
   * @default "SOLUTION_TYPE_SEARCH"
   */
  solutionType?: discoveryengine.GoogleCloudDiscoveryengineV1ServingConfigSolutionTypeEnum;
  /**
   * Custom ranking expression.
   */
  rankingExpression?: string;
  /**
   * Recommendation model id. Required for `SOLUTION_TYPE_RECOMMENDATION`.
   */
  modelId?: string;
  /**
   * Diversity level for recommendation results.
   */
  diversityLevel?: string;
  /**
   * Boost control ids applied at serving time.
   */
  boostControlIds?: string[];
  /**
   * Filter control ids applied at serving time.
   */
  filterControlIds?: string[];
  /**
   * Synonyms control ids.
   */
  synonymsControlIds?: string[];
  /**
   * Redirect control ids.
   */
  redirectControlIds?: string[];
};

export type CollectionsEnginesServingConfig = Resource<
  "GCP.Discoveryengine.CollectionsEnginesServingConfig",
  CollectionsEnginesServingConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Serving config id (last path segment). */
    servingConfigId: string;
    /** Parent engine resource name. */
    engine: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id. */
    collectionId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Solution type. */
    solutionType: string | undefined;
    /** Ranking expression. */
    rankingExpression: string | undefined;
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
 * A Discovery Engine ServingConfig on a collection Engine.
 *
 * Additional serving configs are API-only (the console uses the
 * default). Serving configs have no labels, so Alchemy stamps ownership
 * into `displayName` for `list` / nuke. Parent engine, id, and solution
 * type are immutable; display name, ranking, and control lists update
 * in place.
 *
 * ### Creating a Serving Config
 * **Example:** Extra search serving config
 * ```typescript
 * const serving =
 *   yield* GCP.Discoveryengine.CollectionsEnginesServingConfig("Primary", {
 *     engine: engine.name,
 *     displayName: "primary",
 *   });
 * ```
 *
 * ### Updating a Serving Config
 * **Example:** Rename
 * ```typescript
 * const serving =
 *   yield* GCP.Discoveryengine.CollectionsEnginesServingConfig("Primary", {
 *     engine: existing.engine,
 *     servingConfigId: existing.servingConfigId,
 *     displayName: "primary-prod",
 *   });
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsEnginesServingConfig =
  Resource<CollectionsEnginesServingConfig>(
    "GCP.Discoveryengine.CollectionsEnginesServingConfig",
  );

export class CollectionsEnginesServingConfigNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsEnginesServingConfigNotResolved",
)<{
  name: string;
}> {}

const resourceName = (engine: string, servingConfigId: string) =>
  `${engine}/servingConfigs/${servingConfigId}`;

const solutionOf = (
  value:
    | discoveryengine.GoogleCloudDiscoveryengineV1ServingConfigSolutionTypeEnum
    | undefined,
) => value ?? "SOLUTION_TYPE_SEARCH";

const toId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return servingConfigId(explicit);
    if (existing !== undefined) return existing;
    return servingConfigId(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesServingConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listByEngine = (engine: string) =>
  discoveryengine.listProjectsLocationsCollectionsEnginesServingConfigs
    .pages({ parent: engine, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.servingConfigs ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

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
    engine: parentBefore(name, "servingConfigs"),
    project: parsed.project || project,
    location: parsed.location,
    collectionId: parsed.collectionId,
    displayName: ownership.text,
    solutionType: config.solutionType,
    rankingExpression: config.rankingExpression,
    modelId: config.modelId,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const findOwned = (id: string, engine: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const items = yield* listByEngine(engine);
    for (const item of items) {
      const { labels } = parseOwnership(item.displayName);
      if (yield* hasAlchemyLabels(id, labels)) return item;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1ServingConfig
      | undefined;
  });

export const CollectionsEnginesServingConfigProvider = () =>
  Provider.succeed(CollectionsEnginesServingConfig, {
    stables: [
      "name",
      "servingConfigId",
      "engine",
      "project",
      "location",
      "collectionId",
      "solutionType",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEngine = olds?.engine ?? output?.engine;
      const previousId = olds?.servingConfigId ?? output?.servingConfigId;
      const nextId = news.servingConfigId ?? previousId;
      const previousSolution = solutionOf(
        olds?.solutionType ??
          (output?.solutionType as CollectionsEnginesServingConfigProps["solutionType"]),
      );
      const nextSolution = solutionOf(
        news.solutionType ??
          (output?.solutionType as CollectionsEnginesServingConfigProps["solutionType"]),
      );
      if (
        (previousEngine !== undefined && news.engine !== previousEngine) ||
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousSolution !== nextSolution
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const engine = olds?.engine ?? output?.engine;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : engine !== undefined
            ? yield* findOwned(id, engine)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.displayName);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const engines = yield* listEngines(env.project);
        const rows: ReturnType<typeof toAttrs>[] = [];
        for (const engine of engines) {
          if (engine.name === undefined) continue;
          const items = yield* listByEngine(engine.name);
          for (const item of items) {
            if (hasOwnershipMarker(item.displayName)) {
              rows.push(toAttrs(item, env.project));
            }
          }
        }
        return rows;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const idValue = yield* toId(
        id,
        news.servingConfigId,
        output?.servingConfigId,
      );
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnership(ownership, news.displayName);
      const solutionType = solutionOf(news.solutionType);
      const fallbackName = output?.name ?? resourceName(news.engine, idValue);

      let current = yield* findOwned(id, news.engine, output?.name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsEnginesServingConfigs({
            parent: news.engine,
            servingConfigId: idValue,
            body: {
              displayName,
              solutionType,
              rankingExpression: news.rankingExpression,
              modelId: news.modelId,
              diversityLevel: news.diversityLevel,
              boostControlIds: news.boostControlIds,
              filterControlIds: news.filterControlIds,
              synonymsControlIds: news.synonymsControlIds,
              redirectControlIds: news.redirectControlIds,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(fallbackName)));
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* findOwned(id, news.engine);
        }
      }

      if (current === undefined) {
        return yield* new CollectionsEnginesServingConfigNotResolved({
          name: fallbackName,
        });
      }

      const name = current.name ?? fallbackName;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const rankingChanged =
        (current.rankingExpression ?? "") !== (news.rankingExpression ?? "");
      const modelChanged = (current.modelId ?? "") !== (news.modelId ?? "");
      const diversityChanged =
        (current.diversityLevel ?? "") !== (news.diversityLevel ?? "");
      const boostChanged = !sameStringList(
        current.boostControlIds,
        news.boostControlIds,
      );
      const filterChanged = !sameStringList(
        current.filterControlIds,
        news.filterControlIds,
      );
      const synonymsChanged = !sameStringList(
        current.synonymsControlIds,
        news.synonymsControlIds,
      );
      const redirectChanged = !sameStringList(
        current.redirectControlIds,
        news.redirectControlIds,
      );

      if (
        displayNameChanged ||
        rankingChanged ||
        modelChanged ||
        diversityChanged ||
        boostChanged ||
        filterChanged ||
        synonymsChanged ||
        redirectChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsEnginesServingConfigs(
            {
              name,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                rankingChanged ? "ranking_expression" : undefined,
                modelChanged ? "model_id" : undefined,
                diversityChanged ? "diversity_level" : undefined,
                boostChanged ? "boost_control_ids" : undefined,
                filterChanged ? "filter_control_ids" : undefined,
                synonymsChanged ? "synonyms_control_ids" : undefined,
                redirectChanged ? "redirect_control_ids" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name,
                displayName,
                rankingExpression: news.rankingExpression,
                modelId: news.modelId,
                diversityLevel: news.diversityLevel,
                boostControlIds: news.boostControlIds,
                filterControlIds: news.filterControlIds,
                synonymsControlIds: news.synonymsControlIds,
                redirectControlIds: news.redirectControlIds,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsEnginesServingConfigs({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
