import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { inLookupProject } from "../internal/Lookup.ts";
import type { Providers } from "../Providers.ts";
import {
  identityMappingStoreIdOf,
  LIST_LOCATIONS,
  locationParent,
  normalizeLocation,
  parseResourceName,
  toPhysical,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type IdentityMappingStoreProps = {
  /**
   * Identity Mapping Store id (the last path segment). If omitted, a
   * unique id is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the store. Generated ids are
   * prefixed with `alch` so `list` / nuke can find them.
   */
  identityMappingStoreId?: string;
  /**
   * Location (`global`, `us`, `eu`). Immutable — changing it replaces
   * the store.
   * @default "global"
   */
  location?: string;
  /**
   * Cloud KMS key that protects this store at creation time. Immutable.
   */
  kmsKeyName?: string;
  /**
   * CMEK config resource name used to protect this store.
   */
  cmekConfigName?: string;
  /**
   * When true, skip CMEK even if the project has a default CmekConfig.
   * @default false
   */
  disableCmek?: boolean;
};

export type IdentityMappingStore = Resource<
  "GCP.DiscoveryEngine.IdentityMappingStore",
  IdentityMappingStoreProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/identityMappingStores/{id}`. */
    name: string;
    /** Store id (last path segment). */
    identityMappingStoreId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** CMEK KMS key, if configured. */
    kmsKey: string | undefined;
    /** CMEK config resource name, if configured. */
    cmekConfigName: string | undefined;
  },
  never,
  Providers,
  IdentityMappingStoreLookup
>;

/**
 * Props for {@link IdentityMappingStore.lookup}: find an identity mapping
 * store this stack doesn't manage by its identifiers, in the ambient
 * project unless `project` names another.
 */
export interface IdentityMappingStoreLookup {
  /**
   * Identity Mapping Store id (the last path segment). Generated ids are
   * prefixed with `alch` so `list` / nuke can find them.
   */
  identityMappingStoreId: string;
  /**
   * Location (`global`, `us`, `eu`).
   */
  location?: string;
  /**
   * Project the resource lives in.
   * @default the ambient GCP project
   */
  project?: string;
}

/**
 * A Vertex AI Search Identity Mapping Store.
 *
 * Stores have no labels or display name, so generated ids are prefixed
 * with `alch` for `list` / nuke. Location, id, and CMEK are identity —
 * changing them replaces the store. There is nothing mutable to sync.
 *
 * ### Creating an Identity Mapping Store
 * **Example:** Generated id
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.IdentityMappingStore("Users", {
 *   disableCmek: true,
 * });
 * ```
 *
 * **Example:** Explicit id and location
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.IdentityMappingStore("Users", {
 *   identityMappingStoreId: "app-users",
 *   location: "global",
 *   disableCmek: true,
 * });
 * ```
 *
 * ### Looking up an existing identity mapping store
 * `IdentityMappingStore.lookup` references an identity mapping store
 * Alchemy doesn't manage (created in the console or by another stack). It
 * is read during plan/deploy, never created, updated or deleted, and binds
 * like a declared identity mapping store.
 *
 * **Example:** Reference an existing identity mapping store
 * ```typescript
 * const identityMappingStore = GCP.DiscoveryEngine.IdentityMappingStore.lookup({
 *   identityMappingStoreId: "my-identity-mapping-store",
 * });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const IdentityMappingStore = Resource<IdentityMappingStore>(
  "GCP.DiscoveryEngine.IdentityMappingStore",
);

export class IdentityMappingStoreNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.IdentityMappingStoreNotResolved",
)<{
  resourceName: string;
}> {}

const resourceName = (project: string, location: string, storeId: string) =>
  `${locationParent(project, location)}/identityMappingStores/${storeId}`;

const toAttrs = (
  store: discoveryengine.GoogleCloudDiscoveryengineV1IdentityMappingStore,
  project: string,
) => {
  const name = store.name ?? "";
  const parsed = parseResourceName(name, "identityMappingStores");
  return {
    name,
    identityMappingStoreId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    kmsKey: store.cmekConfig?.kmsKey ?? store.kmsKeyName,
    cmekConfigName: store.cmekConfig?.name,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.undefined
    : discoveryengine
        .getProjectsLocationsIdentityMappingStores({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const isAlchemyId = (storeId: string) => storeId.startsWith("alch");

const listStores = (project: string) =>
  Effect.forEach(
    LIST_LOCATIONS,
    (location) =>
      discoveryengine.listProjectsLocationsIdentityMappingStores
        .pages({
          parent: locationParent(project, location),
          pageSize: 100,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.identityMappingStores ?? [])),
          Stream.filter((store) => isAlchemyId(lastId(store.name))),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        ),
    { concurrency: 2 },
  ).pipe(Effect.map((groups) => groups.flat()));

const lastId = (name: string | undefined) =>
  name
    ? (name
        .split("/")
        .filter((part) => part.length > 0)
        .at(-1) ?? "")
    : "";

export const IdentityMappingStoreProvider = () =>
  Provider.succeed(IdentityMappingStore, {
    stables: ["name", "identityMappingStoreId", "project", "location", "kmsKey", "cmekConfigName"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.identityMappingStoreId ?? output?.identityMappingStoreId;
      const nextId = news.identityMappingStoreId ?? previousId;
      const previousLocation = normalizeLocation(olds?.location ?? output?.location);
      const nextLocation = normalizeLocation(news.location ?? olds?.location ?? output?.location);
      const previousKey = olds?.kmsKeyName ?? output?.kmsKey ?? "";
      const nextKey = news.kmsKeyName ?? previousKey;
      const replace =
        (previousId !== undefined && nextId !== undefined && nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousKey !== nextKey;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation && previousId !== undefined && nextId === previousId,
      };
    }),

    lookup: Effect.fn(function* ({ identityMappingStoreId, location: lookupLocation }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(lookupLocation);
      const name = resourceName(env.project, location, identityMappingStoreId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }, inLookupProject),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const storeId = yield* toPhysical(
        id,
        olds?.identityMappingStoreId,
        output?.identityMappingStoreId,
        identityMappingStoreIdOf,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name = output?.name ?? resourceName(env.project, location, storeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return isAlchemyId(attrs.identityMappingStoreId) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listStores(env.project);
        return stores.map((store) => toAttrs(store, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const storeId = yield* toPhysical(
        id,
        news.identityMappingStoreId,
        output?.identityMappingStoreId,
        identityMappingStoreIdOf,
      );
      const name = resourceName(env.project, location, storeId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsIdentityMappingStores({
            parent: locationParent(env.project, location),
            identityMappingStoreId: storeId,
            cmekConfigName: news.cmekConfigName,
            disableCmek: news.disableCmek === true ? true : undefined,
            body: {
              name,
              kmsKeyName: news.kmsKeyName,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new IdentityMappingStoreNotResolved({ resourceName: name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsIdentityMappingStores({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });
