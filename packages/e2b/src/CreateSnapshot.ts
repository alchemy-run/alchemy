import type * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import type * as snapshots from "@distilled.cloud/e2b/snapshots";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SnapshotSetupFailed } from "./Errors.ts";
import type { SnapshotSetup } from "./internal/SnapshotBuild.ts";
import type { E2BError } from "./SandboxClient.ts";

export type { SnapshotSetup } from "./internal/SnapshotBuild.ts";

/** E2B snapshots: take, list and delete them at runtime. */
export interface SnapshotsClient {
  /**
   * Boots `template`, runs the setup commands, snapshots it under `name` and
   * kills the setup sandbox. Snapshotting under an existing name adds a new
   * version. Use `sandbox.snapshot()` to snapshot a sandbox you already have.
   */
  create(
    name: string,
    setup: SnapshotSetup,
  ): Effect.Effect<sandboxes.SnapshotInfo, E2BError | SnapshotSetupFailed, RuntimeContext>;
  /** Snapshots, filtered by source sandbox or name. */
  list(
    options?: Omit<snapshots.ListSnapshotsRequest, "nextToken">,
  ): Effect.Effect<ReadonlyArray<snapshots.SnapshotInfo>, E2BError, RuntimeContext>;
  /** Deletes a snapshot (and every version of it). Deleting one that is gone succeeds. */
  delete(name: string): Effect.Effect<void, E2BError, RuntimeContext>;
}

/**
 * Take and manage E2B snapshots at runtime: a warm base per repository or
 * per customer, created on demand and forked into sandboxes.
 *
 * Snapshots taken at runtime carry no metadata, so they are not deleted when
 * the host is destroyed. Delete them with `delete` when their owner goes
 * away.
 *
 * ### Warm bases at runtime
 * **Example:** A warm base per repository
 * ```typescript
 * const snapshots = yield* E2B.CreateSnapshot();
 * const sandboxes = yield* E2B.CreateSandbox();
 * // in fetch:
 * const [existing] = yield* snapshots.list({ name: `warm-${slug}` });
 * const base =
 *   existing ??
 *   (yield* snapshots.create(`warm-${slug}`, {
 *     template: "node-22",
 *     run: [`git clone https://github.com/${repo} repo`, "cd repo && npm ci"],
 *   }));
 * const sandbox = yield* sandboxes.create({ templateID: base.snapshotID });
 * ```
 *
 * @binding
 * @product Snapshot
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "E2B.CreateSnapshot",
  () => Effect.Effect<SnapshotsClient>
> {}

export const CreateSnapshot = Binding.Service<CreateSnapshot>("E2B.CreateSnapshot");
