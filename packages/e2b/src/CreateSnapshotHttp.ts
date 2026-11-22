import * as snapshots from "@distilled.cloud/e2b/snapshots";
import * as templates from "@distilled.cloud/e2b/templates";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CreateSnapshot, type SnapshotsClient } from "./CreateSnapshot.ts";
import { bindE2B } from "./E2BBindings.ts";
import { takeSnapshot } from "./internal/SnapshotBuild.ts";

/**
 * HTTP implementation of {@link CreateSnapshot}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const snapshots = yield* E2B.CreateSnapshot();
 *   // ...
 * }).pipe(Effect.provide(E2B.CreateSnapshotHttp))
 * ```
 *
 * @layer
 * @product Snapshot
 * @provides E2B.CreateSnapshot
 */
export const CreateSnapshotHttp = Layer.succeed(
  CreateSnapshot,
  Effect.fn("E2B.CreateSnapshot")(function* () {
    const auth = yield* bindE2B;
    const client: SnapshotsClient = {
      create: (name, setup) => auth.authorize(takeSnapshot(name, setup)),
      list: (options) =>
        auth
          .authorize(Stream.runCollect(snapshots.listSnapshots.items({ ...options })))
          .pipe(Effect.map((all) => Array.from(all))),
      // A snapshot is stored as a template under its name.
      delete: (name) =>
        auth
          .authorize(
            templates
              .getTemplateByAlias({ alias: name })
              .pipe(
                Effect.flatMap((alias) =>
                  templates.deleteTemplate({ templateID: alias.templateID }),
                ),
              ),
          )
          .pipe(
            Effect.asVoid,
            Effect.catchTag("NotFound", () => Effect.void),
          ),
    };
    return client;
  }),
);
