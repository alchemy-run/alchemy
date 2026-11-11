import * as snapshots from "@distilled.cloud/daytona/snapshots";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  CreateSnapshot,
  type CreateSnapshotClient,
  type CreateSnapshotOptions,
} from "./CreateSnapshot.ts";
import { NameOutsidePrefix } from "./CreateVolume.ts";
import { makeAccess, makeOwnerLabels } from "./DaytonaBindings.ts";
import {
  buildSnapshot,
  checkRuntimeDockerfile,
  deleteSnapshot,
  getSnapshot,
  toSnapshotAttributes,
  waitForSnapshot,
} from "./Snapshot.ts";

/** {@link CreateSnapshot} over Daytona's HTTP API; works on any host. */
export const CreateSnapshotHttp = Layer.effect(
  CreateSnapshot,
  Effect.gen(function* () {
    const access = yield* makeAccess;
    return Effect.fn(function* (options?: CreateSnapshotOptions) {
      const { authorize } = yield* access("Snapshots", [
        "write:snapshots",
        "delete:snapshots",
        "write:sandboxes",
        "delete:sandboxes",
      ]);
      // A snapshot has only a name: `prefix` scopes it. The owner labels go
      // on the sandbox a warm base is captured from.
      const labels = yield* makeOwnerLabels;
      const prefix = options?.prefix;
      const client: CreateSnapshotClient = {
        create: ({ name, ...source }) =>
          prefix !== undefined && !name.startsWith(prefix)
            ? Effect.fail(new NameOutsidePrefix({ objectName: name, prefix }))
            : authorize(
                Effect.gen(function* () {
                  if (source.dockerfile !== undefined)
                    yield* checkRuntimeDockerfile(source.dockerfile);
                  const built = yield* buildSnapshot({
                    name,
                    source,
                    labels: yield* labels,
                    note: () => Effect.void,
                  });
                  return toSnapshotAttributes(built, "");
                }),
              ),
        get: (idOrName) =>
          authorize(
            getSnapshot(idOrName).pipe(
              Effect.map((s) => (s ? toSnapshotAttributes(s, "") : undefined)),
            ),
          ),
        list: (input) =>
          authorize(
            snapshots.getAllSnapshots.items({ ...input }).pipe(
              Stream.runCollect,
              Effect.map((all) => Array.from(all, (s) => toSnapshotAttributes(s, ""))),
            ),
          ),
        activate: (idOrName) =>
          authorize(waitForSnapshot(idOrName).pipe(Effect.map((s) => toSnapshotAttributes(s, "")))),
        deactivate: (idOrName) =>
          authorize(snapshots.deactivateSnapshot({ id: idOrName }).pipe(Effect.asVoid)),
        buildLogsUrl: (idOrName) => authorize(snapshots.getSnapshotBuildLogsUrl({ id: idOrName })),
        delete: (idOrName) => authorize(deleteSnapshot(idOrName)),
      };
      return client;
    });
  }),
);
