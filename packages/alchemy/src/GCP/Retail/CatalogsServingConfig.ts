import * as retail from "@distilled.cloud/gcp/retail_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_ID_LENGTH,
  encodeOwnershipLine,
  expandCatalog,
  listProjectCatalogs,
  listServingConfigs,
  normalizeLocation,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  sameStringList,
  sameText,
  slugNoDigits,
  toPhysical,
  updateMaskOf,
} from "./internal.ts";

export type CatalogsServingConfigProps = {
  /**
   * Parent catalog resource name
   * `projects/{project}/locations/{location}/catalogs/{catalog}` or a
   * catalog id (combined with `location`). Immutable — changing it
   * replaces the serving config.
   * @default "default_catalog"
   */
  catalog?: string;
  /**
   * Location used when `catalog` is a bare id. Immutable.
   * @default "global"
   */
  location?: string;
  /**
   * Serving config id (`[a-z-_]`, 4-63 characters). If omitted, a unique
   * id is generated. Immutable — changing it replaces the serving config.
   */
  servingConfigId?: string;
  /**
   * Human-readable name (max 128 characters). Serving configs have no
   * labels field, so Alchemy stamps ownership into this field for
   * `list` / nuke.
   */
  displayName?: string;
  /**
   * Solution types. Immutable. Only one type may be set.
   * @default ["SOLUTION_TYPE_SEARCH"]
   */
  solutionTypes?: Array<
    | "SOLUTION_TYPE_UNSPECIFIED"
    | "SOLUTION_TYPE_RECOMMENDATION"
    | "SOLUTION_TYPE_SEARCH"
    | (string & {})
  >;
  /**
   * Recommendation model id. Required when `solutionTypes` is
   * `SOLUTION_TYPE_RECOMMENDATION`.
   */
  modelId?: string;
  /**
   * Filter control ids.
   */
  filterControlIds?: string[];
  /**
   * Boost control ids.
   */
  boostControlIds?: string[];
  /**
   * Redirect control ids.
   */
  redirectControlIds?: string[];
  /**
   * Two-way synonym control ids.
   */
  twowaySynonymsControlIds?: string[];
  /**
   * One-way synonym control ids.
   */
  onewaySynonymsControlIds?: string[];
  /**
   * Replacement control ids.
   */
  replacementControlIds?: string[];
  /**
   * Ignore control ids.
   */
  ignoreControlIds?: string[];
  /**
   * Do-not-associate control ids.
   */
  doNotAssociateControlIds?: string[];
  /**
   * Facet control ids.
   */
  facetControlIds?: string[];
  /**
   * Recommendation diversity level (`no-diversity`, `low-diversity`, …).
   */
  diversityLevel?: string;
  /**
   * Price reranking level.
   */
  priceRerankingLevel?: string;
};

export type CatalogsServingConfig = Resource<
  "GCP.Retail.CatalogsServingConfig",
  CatalogsServingConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Serving config id. */
    servingConfigId: string;
    /** Parent catalog resource name. */
    catalog: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Solution types. */
    solutionTypes: string[];
    /** Recommendation model id. */
    modelId: string | undefined;
    /** Filter control ids. */
    filterControlIds: string[];
    /** Boost control ids. */
    boostControlIds: string[];
    /** Redirect control ids. */
    redirectControlIds: string[];
    /** Two-way synonym control ids. */
    twowaySynonymsControlIds: string[];
    /** One-way synonym control ids. */
    onewaySynonymsControlIds: string[];
    /** Replacement control ids. */
    replacementControlIds: string[];
    /** Ignore control ids. */
    ignoreControlIds: string[];
    /** Do-not-associate control ids. */
    doNotAssociateControlIds: string[];
    /** Facet control ids. */
    facetControlIds: string[];
    /** Diversity level. */
    diversityLevel: string | undefined;
    /** Price reranking level. */
    priceRerankingLevel: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Retail serving config on a catalog.
 *
 * Serving configs have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent, serving config id, and solution
 * types are immutable. Display name, model id, and control-id lists update
 * in place.
 *
 * ### Creating a Serving Config
 * **Example:** Extra search serving config
 * ```typescript
 * const serving = yield* GCP.Retail.CatalogsServingConfig("Preview", {
 *   displayName: "preview search",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Retail
 */
export const CatalogsServingConfig = Resource<CatalogsServingConfig>(
  "GCP.Retail.CatalogsServingConfig",
);

export class CatalogsServingConfigNotResolved extends Data.TaggedError(
  "GCP.Retail.CatalogsServingConfigNotResolved",
)<{
  name: string;
}> {}

const defaultSolutionTypes = ["SOLUTION_TYPE_SEARCH"] as const;

const toAttrs = (
  config: retail.GoogleCloudRetailV2ServingConfig,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseResourceName(name, "servingConfigs");
  const ownership = parseOwnership(config.displayName);
  return {
    name,
    servingConfigId: parsed.id,
    catalog: parsed.catalog,
    project: parsed.project || project,
    location: parsed.location,
    displayName: ownership.text,
    solutionTypes: [...(config.solutionTypes ?? [])],
    modelId: config.modelId,
    filterControlIds: [...(config.filterControlIds ?? [])],
    boostControlIds: [...(config.boostControlIds ?? [])],
    redirectControlIds: [...(config.redirectControlIds ?? [])],
    twowaySynonymsControlIds: [...(config.twowaySynonymsControlIds ?? [])],
    onewaySynonymsControlIds: [...(config.onewaySynonymsControlIds ?? [])],
    replacementControlIds: [...(config.replacementControlIds ?? [])],
    ignoreControlIds: [...(config.ignoreControlIds ?? [])],
    doNotAssociateControlIds: [...(config.doNotAssociateControlIds ?? [])],
    facetControlIds: [...(config.facetControlIds ?? [])],
    diversityLevel: config.diversityLevel,
    priceRerankingLevel: config.priceRerankingLevel,
  };
};

const resourceName = (catalog: string, servingConfigId: string) =>
  `${catalog}/servingConfigs/${servingConfigId}`;

const toBody = (
  news: CatalogsServingConfigProps,
  displayName: string,
): retail.GoogleCloudRetailV2ServingConfig => ({
  displayName,
  solutionTypes: news.solutionTypes ?? [...defaultSolutionTypes],
  modelId: news.modelId,
  filterControlIds: news.filterControlIds,
  boostControlIds: news.boostControlIds,
  redirectControlIds: news.redirectControlIds,
  twowaySynonymsControlIds: news.twowaySynonymsControlIds,
  onewaySynonymsControlIds: news.onewaySynonymsControlIds,
  replacementControlIds: news.replacementControlIds,
  ignoreControlIds: news.ignoreControlIds,
  doNotAssociateControlIds: news.doNotAssociateControlIds,
  facetControlIds: news.facetControlIds,
  diversityLevel: news.diversityLevel,
  priceRerankingLevel: news.priceRerankingLevel,
});

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : retail
        .getProjectsLocationsCatalogsServingConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (id: string, catalog: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const configs = yield* listServingConfigs(catalog);
    for (const config of configs) {
      if (yield* ownedByAlchemy(id, config.displayName)) return config;
    }
    return undefined as retail.GoogleCloudRetailV2ServingConfig | undefined;
  });

export const CatalogsServingConfigProvider = () =>
  Provider.succeed(CatalogsServingConfig, {
    stables: ["name", "servingConfigId", "catalog", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousParent = olds?.catalog ?? output?.catalog;
      const nextParent = expandCatalog(
        news.catalog,
        env.project,
        normalizeLocation(news.location ?? output?.location),
      );
      const previousTypes = olds?.solutionTypes ?? output?.solutionTypes;
      const nextTypes = news.solutionTypes ?? previousTypes;
      const identity = replaceOnIdentity({
        previousId: olds?.servingConfigId ?? output?.servingConfigId,
        nextId: news.servingConfigId,
        previousParent,
        nextParent,
      });
      if (
        identity !== undefined ||
        (previousTypes !== undefined &&
          nextTypes !== undefined &&
          !sameStringList(previousTypes, nextTypes))
      ) {
        return (
          identity ?? {
            action: "replace" as const,
            deleteFirst: true,
          }
        );
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const catalog = olds?.catalog ?? output?.catalog;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : catalog !== undefined
            ? yield* findOwned(id, catalog)
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
        const catalogs = yield* listProjectCatalogs(env.project);
        const pages = yield* Effect.forEach(
          catalogs,
          (catalog) =>
            catalog.name
              ? listServingConfigs(catalog.name).pipe(
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
      const location = normalizeLocation(news.location ?? output?.location);
      const catalog = expandCatalog(news.catalog, env.project, location);
      const servingConfigId = yield* toPhysical(
        id,
        news.servingConfigId,
        output?.servingConfigId,
        (name) => slugNoDigits(name, MAX_ID_LENGTH),
        MAX_ID_LENGTH,
      );
      const name = resourceName(catalog, servingConfigId);
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName ?? servingConfigId,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const body = toBody(news, displayName);

      let current = yield* findOwned(id, catalog, output?.name);
      if (current === undefined) {
        current = yield* getByName(name);
      }

      if (current === undefined) {
        const created = yield* retail
          .createProjectsLocationsCatalogsServingConfigs({
            parent: catalog,
            servingConfigId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CatalogsServingConfigNotResolved({ name });
      }

      const resource = current.name ?? name;
      const mask = updateMaskOf(
        (current.displayName ?? "") !== displayName
          ? "display_name"
          : undefined,
        sameText(current.modelId, news.modelId) ? undefined : "model_id",
        sameStringList(current.filterControlIds, news.filterControlIds)
          ? undefined
          : "filter_control_ids",
        sameStringList(current.boostControlIds, news.boostControlIds)
          ? undefined
          : "boost_control_ids",
        sameStringList(current.redirectControlIds, news.redirectControlIds)
          ? undefined
          : "redirect_control_ids",
        sameStringList(
          current.twowaySynonymsControlIds,
          news.twowaySynonymsControlIds,
        )
          ? undefined
          : "twoway_synonyms_control_ids",
        sameStringList(
          current.onewaySynonymsControlIds,
          news.onewaySynonymsControlIds,
        )
          ? undefined
          : "oneway_synonyms_control_ids",
        sameStringList(
          current.replacementControlIds,
          news.replacementControlIds,
        )
          ? undefined
          : "replacement_control_ids",
        sameStringList(current.ignoreControlIds, news.ignoreControlIds)
          ? undefined
          : "ignore_control_ids",
        sameStringList(
          current.doNotAssociateControlIds,
          news.doNotAssociateControlIds,
        )
          ? undefined
          : "do_not_associate_control_ids",
        sameStringList(current.facetControlIds, news.facetControlIds)
          ? undefined
          : "facet_control_ids",
        sameText(current.diversityLevel, news.diversityLevel)
          ? undefined
          : "diversity_level",
        sameText(current.priceRerankingLevel, news.priceRerankingLevel)
          ? undefined
          : "price_reranking_level",
      );

      if (mask.length > 0) {
        current = yield* retail.patchProjectsLocationsCatalogsServingConfigs({
          name: resource,
          updateMask: mask,
          body: { ...body, name: resource },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retail
        .deleteProjectsLocationsCatalogsServingConfigs({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
