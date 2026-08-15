/**
 * INTERNAL scaffolding for {@link BlobStore} deletion — NOT exported from
 * the Vercel `index.ts`.
 *
 * Vercel refuses to delete a non-empty blob store (409 `not_empty`,
 * live-verified — see processes/Vercel/PROBES.md) and offers no force
 * parameter, so deleting a store means purging every blob through the data
 * plane first. The data-plane token only materializes as a project env var
 * injected by a store↔project connection, so the purge harvests one:
 *
 *   1. through an EXISTING connection's project when the store is still
 *      connected (the common owned-store case), and otherwise
 *   2. through a throwaway `${name}-reaper` project created, connected,
 *      harvested from, and deleted on the spot — only reached when the
 *      delete actually 409s (an unconnected store holding blobs).
 */
import * as projects from "@distilled.cloud/vercel/projects";
import {
  createStorageStoreConnection,
  deleteStorageStoreConnection,
  deleteStorageStoresBlobById,
  getStorageStoreConnections,
} from "@distilled.cloud/vercel/storage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { deleteProjectByIdOrName, ensureProject } from "../Deploy/Engine.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import {
  DEFAULT_BLOB_API_URL,
  deleteBlobsRaw,
  listBlobsRaw,
  type BlobScope,
} from "./BlobHttp.ts";
import type { BlobStoreAccess } from "./BlobStore.ts";
import { BLOB_TOKEN_ENV } from "./BlobTypes.ts";

class BlobTokenNotInjected extends Data.TaggedError("BlobTokenNotInjected")<{
  projectId: string;
}> {}

/**
 * Read a project's platform-injected `BLOB_READ_WRITE_TOKEN` via the
 * management API's single-env GET (the injected row is `encrypted`; the
 * listing returns a sealed envelope but the single-row GET returns the
 * plaintext). `undefined` when the row has not (yet) been injected.
 */
const readBlobTokenFromProject = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const envsBody = yield* projects.filterProjectEnvs({
      idOrName: projectId,
      teamId,
    });
    const rows = (
      Array.isArray(envsBody)
        ? envsBody
        : typeof envsBody === "object" &&
            envsBody !== null &&
            "envs" in envsBody
          ? (envsBody as { envs: unknown[] }).envs
          : []
    ) as Array<{ key?: string; id?: string }>;
    const tokenRow = rows.find((row) => row.key === BLOB_TOKEN_ENV);
    if (tokenRow?.id === undefined) return undefined;
    const decrypted = yield* projects.getProjectEnv({
      idOrName: projectId,
      id: tokenRow.id,
      teamId,
    });
    return typeof decrypted === "object" &&
      decrypted !== null &&
      "value" in decrypted &&
      typeof decrypted.value === "string" &&
      decrypted.value !== ""
      ? decrypted.value
      : undefined;
  });

/** Bounded retry around the harvest — injection can lag the connect call. */
const harvestToken = (projectId: string, times: number) =>
  readBlobTokenFromProject(projectId).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.fail(new BlobTokenNotInjected({ projectId }))
        : Effect.succeed(value),
    ),
    Effect.retry({
      while: (error) => error._tag === "BlobTokenNotInjected",
      schedule: Schedule.max([
        Schedule.spaced("1 second"),
        Schedule.recurs(times),
      ]),
    }),
    Effect.catchTag("BlobTokenNotInjected", () => Effect.succeed(undefined)),
  );

/** Empty the store through the data plane (batched by page; bounded). */
const purgeBlobs = (scope: BlobScope) =>
  Effect.gen(function* () {
    for (let page = 0; page < 100; page++) {
      const listed = yield* listBlobsRaw(scope, { limit: 1000 });
      if (listed.blobs.length === 0) break;
      // Delete by canonical URL so re-encoding pathnames can't mismatch.
      yield* deleteBlobsRaw(
        scope,
        listed.blobs.map((row) => row.url),
      );
      if (!listed.hasMore) break;
    }
  });

/**
 * Delete a blob store; with `forceDestroy`, purge its contents first —
 * harvesting the data-plane token through an existing connection, or a
 * throwaway reaper project when the store is unconnected but non-empty.
 * Without `forceDestroy` a non-empty store fails with the platform's typed
 * `Conflict` (`not_empty`) — the data-protection default. Idempotent: a
 * store that is already gone is not an error.
 */
export const purgeAndDeleteBlobStore = Effect.fn(function* (options: {
  storeId: string;
  name: string;
  access: BlobStoreAccess;
  forceDestroy: boolean;
}) {
  const { storeId, name, access, forceDestroy } = options;
  const { teamId } = yield* VercelEnvironment.current;

  const connectionsOf = getStorageStoreConnections({ storeId, teamId }).pipe(
    Effect.map((response) => response.connections),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as Array<{ id: string; projectId: string }>),
    ),
  );

  const disconnectAll = Effect.gen(function* () {
    const connections = yield* connectionsOf;
    for (const connection of connections) {
      yield* deleteStorageStoreConnection({
        storeId,
        connectionId: connection.id,
        teamId,
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  });

  const deleteStore = deleteStorageStoresBlobById({
    id: storeId,
    teamId,
  }).pipe(Effect.catchTag("NotFound", () => Effect.void));

  const scopeWith = (token: string): BlobScope => ({
    token: Redacted.make(token),
    storeId,
    access,
    apiUrl: DEFAULT_BLOB_API_URL,
  });

  // 1. With forceDestroy: purge through an existing connection while it
  //    still exists — the common case for an owned store bound to a
  //    Function.
  if (forceDestroy) {
    const connections = yield* connectionsOf;
    if (connections.length > 0) {
      const token = yield* harvestToken(connections[0]!.projectId, 5);
      if (token !== undefined) {
        yield* purgeBlobs(scopeWith(token));
      }
    }
  }

  // 2. Disconnect BEFORE deleting: store deletion does not remove the env
  //    vars its connections injected into projects (observed live).
  yield* disconnectAll;

  // 3. Delete. Without forceDestroy a `not_empty` Conflict propagates
  //    typed (data protection). With it, the Conflict means no usable
  //    token was available above (unconnected store, or a connection whose
  //    project we could not read) — build a throwaway reaper project,
  //    purge through it, retry.
  if (!forceDestroy) {
    return yield* deleteStore;
  }
  yield* deleteStore.pipe(
    Effect.catchTag("Conflict", () =>
      Effect.gen(function* () {
        const reaper = yield* ensureProject({ name: `${name}-reaper` });
        yield* Effect.gen(function* () {
          yield* createStorageStoreConnection({
            storeId,
            projectId: reaper.id,
            envVarEnvironments: ["production", "preview", "development"],
            type: "integration",
            teamId,
          }).pipe(
            // Already-connected race (`store_project_connection_not_unique`):
            // trust observation.
            Effect.catchTag("BadRequest", (error) =>
              connectionsOf.pipe(
                Effect.flatMap((after) =>
                  after.some((connection) => connection.projectId === reaper.id)
                    ? Effect.void
                    : Effect.fail(error),
                ),
              ),
            ),
          );
          const token = yield* harvestToken(reaper.id, 15);
          if (token !== undefined) {
            yield* purgeBlobs(scopeWith(token));
          }
          yield* disconnectAll;
          yield* deleteStore;
        }).pipe(
          // The reaper is transient bookkeeping: remove it whether or not
          // the purge succeeded (deleting the project also removes the
          // injected env row; the connection was already disconnected).
          Effect.ensuring(
            deleteProjectByIdOrName(reaper.id).pipe(Effect.ignore),
          ),
        );
      }),
    ),
  );
});
