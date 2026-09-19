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
  expandDataStore,
  internalLabels,
  listProjectDataStores,
  parseResourceName,
  targetSiteHasOwnership,
  targetSiteUriOf,
} from "./internal.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type DataStoresSiteSearchEngineTargetSiteProps = {
  /**
   * Parent Data Store resource name
   * `projects/{project}/locations/{location}/dataStores/{dataStore}`.
   * The data store must use `PUBLIC_WEBSITE` content. Immutable —
   * changing it replaces the target site.
   */
  dataStore: string;
  /**
   * User-provided URI pattern from which the generated URI pattern is
   * derived (for example `www.example.com`). Input-only. Alchemy encodes
   * ownership in a generated path when this is omitted so `list` / nuke
   * can find the site.
   */
  providedUriPattern?: string;
  /**
   * When true, match the provided URI pattern exactly. Immutable —
   * changing it replaces the target site.
   * @default false
   */
  exactMatch?: boolean;
  /**
   * Whether the site is included or excluded (`INCLUDE`, `EXCLUDE`).
   * @default "INCLUDE"
   */
  type?: string;
};

export type DataStoresSiteSearchEngineTargetSite = Resource<
  "GCP.Discoveryengine.DataStoresSiteSearchEngineTargetSite",
  DataStoresSiteSearchEngineTargetSiteProps,
  {
    /** Full resource name `.../siteSearchEngine/targetSites/{targetSite}`. */
    name: string;
    /** Target site id (last path segment). Server-assigned on create. */
    targetSiteId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-provided URI pattern. */
    providedUriPattern: string | undefined;
    /** System-generated URI pattern. */
    generatedUriPattern: string | undefined;
    /** Root domain of the provided URI pattern. */
    rootDomainUri: string | undefined;
    /** Whether the URI pattern is an exact match. */
    exactMatch: boolean;
    /** Include or exclude. */
    type: string | undefined;
    /** Indexing status. */
    indexingStatus: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Search TargetSite under a Data Store site search engine.
 *
 * Target sites have no labels field, so Alchemy encodes ownership in the
 * generated URI path (`www.example.com/alchemy/{stack}/{stage}/{id}`)
 * when `providedUriPattern` is omitted. The target site id is
 * server-assigned. Parent and exact-match flag are immutable; type
 * updates in place (LRO).
 *
 * ### Creating a Target Site
 * **Example:** Include a site
 * ```typescript
 * const site = yield* GCP.Discoveryengine.DataStoresSiteSearchEngineTargetSite(
 *   "Docs",
 *   {
 *     dataStore: dataStore.name,
 *     providedUriPattern: "www.example.com/docs",
 *     type: "INCLUDE",
 *   },
 * );
 * ```
 *
 * ### Updating a Target Site
 * **Example:** Exclude the site
 * ```typescript
 * const site = yield* GCP.Discoveryengine.DataStoresSiteSearchEngineTargetSite(
 *   "Docs",
 *   {
 *     dataStore: existing.dataStore,
 *     providedUriPattern: existing.providedUriPattern,
 *     type: "EXCLUDE",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const DataStoresSiteSearchEngineTargetSite =
  Resource<DataStoresSiteSearchEngineTargetSite>(
    "GCP.Discoveryengine.DataStoresSiteSearchEngineTargetSite",
  );

export class DataStoresSiteSearchEngineTargetSiteNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.DataStoresSiteSearchEngineTargetSiteNotResolved",
)<{
  name: string;
}> {}

const siteSearchEngine = (dataStore: string) => `${dataStore}/siteSearchEngine`;

const toAttrs = (
  site: discoveryengine.GoogleCloudDiscoveryengineV1TargetSite,
  project: string,
) => {
  const name = site.name ?? "";
  const parsed = parseResourceName(name, "targetSites");
  return {
    name,
    targetSiteId: parsed.id,
    dataStore: parsed.dataStore,
    project: parsed.project || project,
    location: parsed.location,
    providedUriPattern: site.providedUriPattern ?? site.generatedUriPattern,
    generatedUriPattern: site.generatedUriPattern,
    rootDomainUri: site.rootDomainUri,
    exactMatch: site.exactMatch === true,
    type: site.type,
    indexingStatus: site.indexingStatus,
    updateTime: site.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsDataStoresSiteSearchEngineTargetSites({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsDataStoresSiteSearchEngineTargetSites
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.targetSites ?? [])),
      Stream.filter((site) => targetSiteHasOwnership(site.providedUriPattern)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const findOwned = (uri: string, parent: string | undefined, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    if (parent === undefined) return undefined;
    const sites = yield* listAtParent(parent);
    return sites.find((site) => site.providedUriPattern === uri);
  });

export const DataStoresSiteSearchEngineTargetSiteProvider = () =>
  Provider.succeed(DataStoresSiteSearchEngineTargetSite, {
    stables: [
      "name",
      "targetSiteId",
      "dataStore",
      "project",
      "location",
      "providedUriPattern",
      "exactMatch",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      if (previousParent !== undefined && news.dataStore !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousExact = olds?.exactMatch ?? output?.exactMatch ?? false;
      const nextExact = news.exactMatch ?? previousExact;
      if (previousExact !== nextExact) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousUri =
        olds?.providedUriPattern ?? output?.providedUriPattern;
      if (
        previousUri !== undefined &&
        news.providedUriPattern !== undefined &&
        news.providedUriPattern !== previousUri
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousType = olds?.type ?? output?.type ?? "INCLUDE";
      const nextType = news.type ?? previousType;
      if (previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.dataStore
        ? expandDataStore(
            olds.dataStore,
            env.project,
            output?.location ?? "global",
          )
        : undefined;
      const labels = yield* internalLabels(id);
      const uri = targetSiteUriOf(
        labels,
        olds?.providedUriPattern ?? output?.providedUriPattern,
      );
      const existing = yield* findOwned(
        uri,
        parent ? siteSearchEngine(parent) : undefined,
        output?.name,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return targetSiteHasOwnership(existing.providedUriPattern) ||
        (olds?.providedUriPattern !== undefined &&
          existing.providedUriPattern === olds.providedUriPattern)
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
              ? listAtParent(siteSearchEngine(store.name)).pipe(
                  Effect.map((sites) =>
                    sites.map((site) => toAttrs(site, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandDataStore(
        news.dataStore,
        env.project,
        output?.location ?? "global",
      );
      const engine = siteSearchEngine(parent);
      const labels = yield* internalLabels(id);
      const providedUriPattern = targetSiteUriOf(
        labels,
        news.providedUriPattern ?? output?.providedUriPattern,
      );
      const exactMatch = news.exactMatch === true;
      const type = news.type ?? "INCLUDE";

      let current = yield* findOwned(providedUriPattern, engine, output?.name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStoresSiteSearchEngineTargetSites({
            parent: engine,
            body: {
              providedUriPattern,
              exactMatch,
              type,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = resourceNameFromOperation(done);
          if (createdName !== undefined) {
            current = yield* getByName(createdName);
          }
        }
        if (current === undefined) {
          current = yield* findOwned(providedUriPattern, engine);
        }
      }

      if (current === undefined) {
        return yield* new DataStoresSiteSearchEngineTargetSiteNotResolved({
          name: output?.name ?? `${engine}/targetSites`,
        });
      }

      const typeChanged =
        news.type !== undefined && (current.type ?? "INCLUDE") !== type;

      if (typeChanged) {
        const patched =
          yield* discoveryengine.patchProjectsLocationsDataStoresSiteSearchEngineTargetSites(
            {
              name: current.name ?? "",
              body: {
                name: current.name,
                providedUriPattern,
                exactMatch,
                type,
              },
            },
          );
        const done = yield* waitForOperation(patched);
        const patchedName =
          resourceNameFromOperation(done) ?? current.name ?? "";
        current = (yield* getByName(patchedName)) ?? current;
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsDataStoresSiteSearchEngineTargetSites({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
