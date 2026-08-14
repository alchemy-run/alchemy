import {
  createStorageStoreConnection,
  createStorageStoresBlob,
  deleteStorageStoreConnection,
  deleteStorageStoresBlobById,
  getStorageStoreConnections,
  getStorageStores,
  getStorageStoresById,
  type GetStorageStoresByIdResponse,
} from "@distilled.cloud/vercel/storage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_ACCESS: BlobStoreAccess = "public";
const DEFAULT_REGION: BlobStoreRegion = "iad1";
const ALL_ENVIRONMENTS: BlobStoreEnvironment[] = [
  "production",
  "preview",
  "development",
];

export type BlobStoreAccess = "public" | "private";

export type BlobStoreEnvironment = "production" | "preview" | "development";

export type BlobStoreRegion =
  | "arn1"
  | "bom1"
  | "cdg1"
  | "cle1"
  | "cpt1"
  | "dub1"
  | "dxb1"
  | "fra1"
  | "gru1"
  | "hkg1"
  | "hnd1"
  | "iad1"
  | "icn1"
  | "kix1"
  | "lhr1"
  | "pdx1"
  | "sfo1"
  | "sin1"
  | "syd1"
  | "yul1";

export interface BlobStoreProps {
  /**
   * Name of the store. If omitted, a unique name is generated from
   * `${app}-${stage}-${id}`. Changing the name forces a replacement.
   */
  name?: string;
  /**
   * Access mode of the store. Public blobs are world-readable at their
   * blob URL; private blobs require an authenticated data-plane request.
   * Cannot be changed after creation (forces a replacement).
   *
   * @default "public"
   */
  access?: BlobStoreAccess;
  /**
   * Region the store's data is placed in. Cannot be changed after
   * creation (forces a replacement).
   *
   * @default "iad1"
   */
  region?: BlobStoreRegion;
  /**
   * Project IDs to connect the store to. Connecting a project injects a
   * `BLOB_READ_WRITE_TOKEN` (encrypted) environment variable into the
   * project for the environments in {@link BlobStoreProps.envVarEnvironments},
   * which is how deployed functions (and `alchemy` itself) acquire the
   * store's data-plane token. Removing a project from this list
   * disconnects it and removes the injected variable.
   */
  projects?: string[];
  /**
   * Environments that receive the injected token env var on each project
   * connection.
   *
   * @default ["production", "preview", "development"]
   */
  envVarEnvironments?: BlobStoreEnvironment[];
}

/**
 * The Binding Contract of a {@link BlobStore}: capabilities (the
 * `ReadBlob`/`WriteBlob`/`ReadWriteBlob` bindings) contribute the host
 * Function's project id here, and the store's reconciler merges the
 * contributions with the `projects` prop before syncing connections. This
 * is how binding a store to a Function transparently connects the
 * Function's project (which injects the platform's data-plane token env).
 */
export interface BlobStoreBinding {
  /** Project IDs to connect (merged with {@link BlobStoreProps.projects}). */
  projects?: string[];
}

export type BlobStore = Resource<
  "Vercel.BlobStore",
  BlobStoreProps,
  {
    /** Unique store identifier, e.g. `store_XXXXXXXXXXXXXXXX`. */
    storeId: string;
    /** Name of the store. */
    name: string;
    /** Access mode of the store. */
    access: BlobStoreAccess;
    /** Region the store's data is placed in. */
    region: string;
    /** IDs of the projects currently connected to the store (sorted). */
    projectIds: string[];
    /** Environments the injected token env var targets on each connection. */
    envVarEnvironments: BlobStoreEnvironment[];
  },
  BlobStoreBinding,
  Providers
>;

type BlobStoreAttributes = BlobStore["Attributes"];

/**
 * A Vercel Blob store — object storage addressed by pathname, served from
 * a global CDN. Public stores serve blobs from world-readable URLs;
 * private stores require authenticated reads.
 *
 * Vercel has no resource tags, so ownership is tracked through
 * deterministic naming plus alchemy state. Projects are connected through
 * the store↔project connection API, which injects a
 * `BLOB_READ_WRITE_TOKEN` environment variable into the connected
 * project — the data-plane credential used at runtime.
 *
 * @resource
 * @section Creating a Blob Store
 * @example Basic store
 * ```typescript
 * const uploads = yield* Vercel.BlobStore("Uploads");
 * ```
 *
 * @example Private store in a specific region
 * ```typescript
 * const uploads = yield* Vercel.BlobStore("Uploads", {
 *   access: "private",
 *   region: "fra1",
 * });
 * ```
 *
 * @section Connecting Projects
 * @example Inject the store token into a project
 * ```typescript
 * const uploads = yield* Vercel.BlobStore("Uploads", {
 *   access: "private",
 *   projects: ["prj_XXXXXXXXXXXXXXXXXXXXXXXXXXXX"],
 * });
 * // the project now has BLOB_READ_WRITE_TOKEN in production/preview/development
 * ```
 *
 * @example Limit the injected env var to production
 * ```typescript
 * const uploads = yield* Vercel.BlobStore("Uploads", {
 *   projects: ["prj_XXXXXXXXXXXXXXXXXXXXXXXXXXXX"],
 *   envVarEnvironments: ["production"],
 * });
 * ```
 *
 * @section Binding to a Function
 * @example Connect through the ReadWriteBlob capability
 * Inside an Effect-native Function, binding the store connects the
 * Function's project automatically — no `projects:` prop needed (see
 * {@link BlobStoreBinding}).
 * ```typescript
 * const uploads = yield* Vercel.ReadWriteBlob(Uploads);
 * // deploy: connects the Function's project (injects BLOB_READ_WRITE_TOKEN)
 * // runtime: uploads.put / get / head / list / del
 * ```
 *
 * @see https://vercel.com/docs/vercel-blob
 */
export const BlobStore = Resource<BlobStore>("Vercel.BlobStore");

export const BlobStoreProvider = () =>
  Provider.succeed(BlobStore, {
    stables: ["storeId"],
    list: Effect.fn(function* () {
      const { teamId } = yield* VercelEnvironment.current;
      const { stores } = yield* getStorageStores({ teamId });
      const rows = yield* Effect.forEach(
        stores.filter((store) => store.type === "blob"),
        (store) =>
          hydrateStoreAttributes(store.id).pipe(
            // A store can be deleted between the list call and hydration —
            // skip it rather than fail the whole enumeration.
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          ),
        { concurrency: 5 },
      );
      return rows.filter(
        (row): row is BlobStoreAttributes => row !== undefined,
      );
    }),
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      if (!isResolved(news)) return undefined;
      const oldName = output?.name ?? (yield* createStoreName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      if (
        oldName !== name ||
        (news.access ?? output?.access ?? DEFAULT_ACCESS) !==
          (output?.access ?? olds.access ?? DEFAULT_ACCESS) ||
        (news.region ?? output?.region ?? DEFAULT_REGION) !==
          (output?.region ?? olds.region ?? DEFAULT_REGION)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      if (output?.storeId) {
        return yield* hydrateStoreAttributes(output.storeId).pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      }
      const name = yield* createStoreName(id, olds?.name);
      const match = yield* findStoreByName(name);
      if (!match) return undefined;
      return yield* hydrateStoreAttributes(match.id).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output, bindings }) {
      const { teamId } = yield* VercelEnvironment.current;

      // Observe — `output.storeId` is a cache, not a guarantee: fall
      // through to find-by-name / create when the store no longer exists.
      const name = output?.name ?? (yield* createStoreName(id, news.name));
      let store = output?.storeId
        ? yield* getStorageStoresById({ id: output.storeId, teamId }).pipe(
            Effect.map((r) => r.store),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          )
        : yield* findStoreByName(name).pipe(
            Effect.flatMap((match) =>
              match
                ? getStorageStoresById({ id: match.id, teamId }).pipe(
                    Effect.map(
                      (r): GetStorageStoresByIdResponse["store"] | undefined =>
                        r.store,
                    ),
                    Effect.catchTag("NotFound", () =>
                      Effect.succeed(undefined),
                    ),
                  )
                : Effect.succeed(undefined),
            ),
          );

      // Ensure — create when missing; tolerate a concurrent create of the
      // same name as a race and re-observe.
      if (store === undefined) {
        store = yield* createStorageStoresBlob({
          name,
          access: news.access ?? DEFAULT_ACCESS,
          region: news.region ?? DEFAULT_REGION,
          teamId,
        }).pipe(
          Effect.flatMap((created) =>
            created.store
              ? getStorageStoresById({ id: created.store.id, teamId }).pipe(
                  Effect.map((r) => r.store),
                )
              : // The API declares the created store nullable; re-observe by
                // name so a null body cannot leave us without attributes.
                requireStoreByName(name),
          ),
          Effect.catchTag("Conflict", () => requireStoreByName(name)),
        );
      }
      const storeId = store.id;

      // Sync connections — diff OBSERVED connections against the desired
      // project list (props ∪ binding-contributed project ids, see
      // {@link BlobStoreBinding}); apply only the delta. Each half is
      // idempotent.
      const contributedProjects = (bindings ?? [])
        .filter(
          (b: ResourceBinding<BlobStoreBinding> & { action?: string }) =>
            b.action !== "delete",
        )
        .flatMap((b) => b?.data?.projects ?? []);
      const desiredProjects = [
        ...new Set([...(news.projects ?? []), ...contributedProjects]),
      ];
      const desiredEnvs = normalizeEnvironments(news.envVarEnvironments);
      const observed = yield* getStorageStoreConnections({ storeId, teamId });

      for (const connection of observed.connections) {
        const wanted = desiredProjects.includes(connection.projectId);
        const sameEnvs =
          normalizeEnvironments([...connection.envVarEnvironments]).join(
            ",",
          ) === desiredEnvs.join(",");
        if (!wanted || !sameEnvs) {
          // Disconnect removes the injected env var from the project; a
          // changed environment list is disconnect + reconnect below.
          yield* deleteStorageStoreConnection({
            storeId,
            connectionId: connection.id,
            teamId,
          }).pipe(Effect.catchTag("NotFound", () => Effect.void));
        }
      }
      const connected = new Set(
        observed.connections
          .filter(
            (connection) =>
              desiredProjects.includes(connection.projectId) &&
              normalizeEnvironments([...connection.envVarEnvironments]).join(
                ",",
              ) === desiredEnvs.join(","),
          )
          .map((connection) => connection.projectId),
      );
      for (const projectId of desiredProjects) {
        if (connected.has(projectId)) continue;
        yield* createStorageStoreConnection({
          storeId,
          projectId,
          envVarEnvironments: desiredEnvs,
          type: "integration",
          teamId,
        }).pipe(
          // A 400 here can be the already-connected race
          // (`store_project_connection_not_unique`) — trust observation:
          // re-read the connections and only propagate the error if the
          // project is genuinely not connected.
          Effect.catchTag("BadRequest", (error) =>
            getStorageStoreConnections({ storeId, teamId }).pipe(
              Effect.flatMap((after) =>
                after.connections.some(
                  (connection) => connection.projectId === projectId,
                )
                  ? Effect.void
                  : Effect.fail(error),
              ),
            ),
          ),
        );
      }

      // Return — re-read the final connection state.
      const final = yield* getStorageStoreConnections({ storeId, teamId });
      return {
        storeId,
        name: store.name,
        access: (store.access ??
          news.access ??
          DEFAULT_ACCESS) as BlobStoreAccess,
        region: store.region ?? news.region ?? DEFAULT_REGION,
        projectIds: final.connections
          .map((connection) => connection.projectId)
          .sort(),
        envVarEnvironments: desiredEnvs,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      // Deleting a store does NOT remove the env vars its connections
      // injected into projects (observed live), so disconnect first.
      yield* getStorageStoreConnections({
        storeId: output.storeId,
        teamId,
      }).pipe(
        Effect.flatMap((observed) =>
          Effect.forEach(
            observed.connections,
            (connection) =>
              deleteStorageStoreConnection({
                storeId: output.storeId,
                connectionId: connection.id,
                teamId,
              }).pipe(Effect.catchTag("NotFound", () => Effect.void)),
            { discard: true },
          ),
        ),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* deleteStorageStoresBlobById({ id: output.storeId, teamId }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });

const createStoreName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const normalizeEnvironments = (
  environments: BlobStoreEnvironment[] | undefined,
): BlobStoreEnvironment[] =>
  [...new Set(environments?.length ? environments : ALL_ENVIRONMENTS)].sort();

const findStoreByName = (name: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const { stores } = yield* getStorageStores({ teamId });
    return stores.find((store) => store.type === "blob" && store.name === name);
  });

class BlobStoreVanished extends Data.TaggedError("BlobStoreVanished")<{
  message: string;
}> {}

const requireStoreByName = (name: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const match = yield* findStoreByName(name);
    if (!match) {
      return yield* new BlobStoreVanished({
        message: `Blob store '${name}' was expected to exist but was not found`,
      });
    }
    return (yield* getStorageStoresById({ id: match.id, teamId })).store;
  });

const hydrateStoreAttributes = (storeId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const { store } = yield* getStorageStoresById({ id: storeId, teamId });
    if (store.type !== "blob") return undefined;
    const { connections } = yield* getStorageStoreConnections({
      storeId,
      teamId,
    });
    const envVarEnvironments = normalizeEnvironments(
      connections[0]
        ? [...connections[0].envVarEnvironments]
        : ALL_ENVIRONMENTS,
    );
    return {
      storeId: store.id,
      name: store.name,
      access: (store.access ?? DEFAULT_ACCESS) as BlobStoreAccess,
      region: store.region ?? DEFAULT_REGION,
      projectIds: connections.map((connection) => connection.projectId).sort(),
      envVarEnvironments,
    } satisfies BlobStoreAttributes;
  });
