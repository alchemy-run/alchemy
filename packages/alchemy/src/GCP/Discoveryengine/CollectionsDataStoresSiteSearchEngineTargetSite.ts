import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  listProjectDataStores,
  ownershipLabels,
  parentOf,
  parseResourceName,
  siteSearchEngineParent,
} from "./internal.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";

export type CollectionsDataStoresSiteSearchEngineTargetSiteProps = {
  /**
   * Parent data store resource name (must use `PUBLIC_WEBSITE` content
   * config). Immutable — changing it replaces the target site.
   */
  dataStore: string;
  /**
   * User-provided URI pattern used to generate the crawl pattern.
   * Required. Target sites have no labels field, so Alchemy stamps
   * ownership as a `/alchemy/{id}/` path suffix when the pattern does
   * not already contain one.
   */
  providedUriPattern: string;
  /**
   * Whether the site is included or excluded.
   * @default "INCLUDE"
   */
  type?: "TYPE_UNSPECIFIED" | "INCLUDE" | "EXCLUDE" | (string & {});
  /**
   * Exact-match URI pattern generation. Immutable after create.
   * @default false
   */
  exactMatch?: boolean;
};

export type CollectionsDataStoresSiteSearchEngineTargetSite = Resource<
  "GCP.Discoveryengine.CollectionsDataStoresSiteSearchEngineTargetSite",
  CollectionsDataStoresSiteSearchEngineTargetSiteProps,
  {
    /** Full resource name. */
    name: string;
    /** System-generated target site id. */
    targetSiteId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-provided URI pattern. */
    providedUriPattern: string;
    /** Generated URI pattern. */
    generatedUriPattern: string | undefined;
    /** Include or exclude. */
    type: string | undefined;
    /** Exact-match flag. */
    exactMatch: boolean;
    /** Indexing status. */
    indexingStatus: string | undefined;
    /** Root domain of the provided URI pattern. */
    rootDomainUri: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine target site on a collection data store site-search
 * engine.
 *
 * Target sites have no labels field, so Alchemy stamps ownership into the
 * URI pattern (`/alchemy/{id}/`) for `list` / nuke. Parent data store and
 * `exactMatch` are immutable. Type updates in place. The target site id is
 * assigned by the API.
 *
 * ### Creating a Target Site
 * **Example:** Include a site
 * ```typescript
 * const store = yield* GCP.Discoveryengine.CollectionsDataStore("Web", {
 *   contentConfig: "PUBLIC_WEBSITE",
 * });
 * const site = yield* GCP.Discoveryengine.CollectionsDataStoresSiteSearchEngineTargetSite(
 *   "Docs",
 *   {
 *     dataStore: store.name,
 *     providedUriPattern: "https://example.com/docs/",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Discoveryengine
 */
export const CollectionsDataStoresSiteSearchEngineTargetSite =
  Resource<CollectionsDataStoresSiteSearchEngineTargetSite>(
    "GCP.Discoveryengine.CollectionsDataStoresSiteSearchEngineTargetSite",
  );

export class CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved",
)<{
  name: string;
}> {}

export class CollectionsDataStoresSiteSearchEngineTargetSiteStillExists extends Data.TaggedError(
  "GCP.Discoveryengine.CollectionsDataStoresSiteSearchEngineTargetSiteStillExists",
)<{
  name: string;
}> {}

const OWNERSHIP_RE = /\/alchemy\/([^/]+)\/?/;

const encodeUriPattern = (pattern: string, alchemyId: string) => {
  const stripped = pattern.replace(/^https?:\/\//, "");
  if (stripped.includes("/alchemy/")) return stripped;
  const trimmed = stripped.replace(/\/+$/, "");
  return `${trimmed}/alchemy/${alchemyId}/`;
};

const parseUriOwnership = (pattern: string | undefined) => {
  if (pattern === undefined) return { id: undefined as string | undefined };
  const match = pattern.match(OWNERSHIP_RE);
  return { id: match?.[1] };
};

const toAttrs = (
  site: discoveryengine.GoogleCloudDiscoveryengineV1TargetSite,
  project: string,
) => {
  const name = site.name ?? "";
  const parsed = parseResourceName(name, "targetSites");
  return {
    name,
    targetSiteId: parsed.id,
    dataStore: parentOf(name, "siteSearchEngine"),
    project: parsed.project || project,
    location: parsed.location,
    providedUriPattern: site.providedUriPattern ?? "",
    generatedUriPattern: site.generatedUriPattern,
    type: site.type,
    exactMatch: site.exactMatch === true,
    indexingStatus: site.indexingStatus,
    rootDomainUri: site.rootDomainUri,
    updateTime: site.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites({
          name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.targetSites ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
      Effect.catchTag("Forbidden", () => Effect.succeed([])),
    );

const findOwned = (
  alchemyId: string,
  dataStore: string,
  pattern: string,
  hinted?: string,
) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const sites = yield* listAtParent(siteSearchEngineParent(dataStore));
    for (const site of sites) {
      const parsed = parseUriOwnership(site.providedUriPattern);
      if (parsed.id === alchemyId) return site;
      if ((site.providedUriPattern ?? "") === pattern) return site;
    }
    return undefined as
      | discoveryengine.GoogleCloudDiscoveryengineV1TargetSite
      | undefined;
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((site) =>
      site
        ? Effect.succeed(site)
        : Effect.fail(
            new CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved({
              name,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.Discoveryengine.CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((site) =>
      site === undefined
        ? Effect.void
        : Effect.fail(
            new CollectionsDataStoresSiteSearchEngineTargetSiteStillExists({
              name,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.Discoveryengine.CollectionsDataStoresSiteSearchEngineTargetSiteStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const CollectionsDataStoresSiteSearchEngineTargetSiteProvider = () =>
  Provider.succeed(CollectionsDataStoresSiteSearchEngineTargetSite, {
    stables: [
      "name",
      "targetSiteId",
      "dataStore",
      "project",
      "location",
      "exactMatch",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousExact = olds?.exactMatch ?? output?.exactMatch ?? false;
      const nextExact = news.exactMatch ?? previousExact;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        previousExact !== nextExact
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* ownershipLabels(id);
      const alchemyId = ownership["alchemy-id"] ?? "";
      const dataStore = olds?.dataStore ?? output?.dataStore;
      const pattern = olds?.providedUriPattern ?? output?.providedUriPattern;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : dataStore !== undefined && pattern !== undefined
            ? yield* findOwned(alchemyId, dataStore, pattern)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseUriOwnership(existing.providedUriPattern);
      return parsed.id === alchemyId ||
        (pattern !== undefined && existing.providedUriPattern === pattern)
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
              ? listAtParent(siteSearchEngineParent(store.name)).pipe(
                  Effect.map((sites) =>
                    sites
                      .filter(
                        (site) =>
                          parseUriOwnership(site.providedUriPattern).id !==
                          undefined,
                      )
                      .map((site) => toAttrs(site, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* ownershipLabels(id);
      const alchemyId = ownership["alchemy-id"] ?? "x";
      const providedUriPattern = encodeUriPattern(
        news.providedUriPattern,
        alchemyId,
      );
      const type = news.type ?? "INCLUDE";
      const exactMatch = news.exactMatch === true;
      const parent = siteSearchEngineParent(news.dataStore);

      let current = yield* findOwned(
        alchemyId,
        news.dataStore,
        providedUriPattern,
        output?.name,
      );

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites(
            {
              parent,
              body: {
                providedUriPattern,
                type,
                exactMatch: exactMatch ? true : undefined,
              },
            },
          )
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const createdName = resourceNameFromOperation(done);
          if (createdName !== undefined) {
            current = yield* waitUntilExists(createdName);
          }
        }
        if (current === undefined) {
          current = yield* findOwned(
            alchemyId,
            news.dataStore,
            providedUriPattern,
          );
        }
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved(
          { name: output?.name ?? `${parent}/targetSites/-` },
        );
      }

      const resource = current.name ?? "";
      const typeChanged = (current.type ?? "INCLUDE") !== type;
      const patternChanged =
        (current.providedUriPattern ?? "") !== providedUriPattern;

      if (typeChanged || patternChanged) {
        const patched =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites(
            {
              name: resource,
              body: {
                name: resource,
                providedUriPattern,
                type,
                exactMatch: current.exactMatch,
              },
            },
          );
        const done = yield* waitForOperation(patched);
        current = yield* waitUntilExists(
          resourceNameFromOperation(done) ?? resource,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites(
          { name: output.name },
        )
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
