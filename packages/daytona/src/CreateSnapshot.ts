import type { UnsupportedDockerfile } from "@alchemy.run/docker/BuildPlan";
import type { DockerfileSyntaxError } from "@alchemy.run/docker/DockerfileParser";
import type * as sandboxes from "@distilled.cloud/daytona/sandbox";
import type * as snapshots from "@distilled.cloud/daytona/snapshots";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { NameOutsidePrefix } from "./CreateVolume.ts";
import type { ProcessError } from "./internal/Errors.ts";
import type { StateFailed, StateTimeout } from "./internal/Wait.ts";
import type {
  ResolvedSnapshotSource,
  SnapshotAttributes,
  SnapshotContextUnsupported,
  SnapshotImageTagInvalid,
  SnapshotRunFailed,
} from "./Snapshot.ts";

/** `create` input: a name and one source, as `Daytona.Snapshot` takes them (Dockerfile as content). */
export interface CreateSnapshotInput extends Omit<ResolvedSnapshotSource, "contextHashes"> {
  readonly name: string;
}

export interface CreateSnapshotClient {
  /**
   * Build a snapshot and wait until it is active: pull `image`, build
   * `dockerfile` on Daytona, or start a sandbox from `from`, `run` the
   * commands and capture it. Returns the same attributes as
   * `Daytona.Snapshot`.
   */
  create(
    input: CreateSnapshotInput,
  ): Effect.Effect<
    SnapshotAttributes,
    | snapshots.CreateSnapshotError
    | snapshots.GetSnapshotError
    | snapshots.ActivateSnapshotError
    | sandboxes.CreateSandboxError
    | sandboxes.GetSandboxError
    | sandboxes.CreateSandboxSnapshotError
    | ProcessError
    | SnapshotRunFailed
    | SnapshotImageTagInvalid
    | SnapshotContextUnsupported
    | UnsupportedDockerfile
    | DockerfileSyntaxError
    | StateTimeout
    | StateFailed
    | NameOutsidePrefix,
    RuntimeContext
  >;
  /** The snapshot with this id or name, or `undefined`. */
  get(
    idOrName: string,
  ): Effect.Effect<SnapshotAttributes | undefined, snapshots.GetSnapshotError, RuntimeContext>;
  /** Snapshots matching Daytona's list filters. */
  list(
    input?: Omit<snapshots.GetAllSnapshotsRequest, "xDaytonaOrganizationID" | "page">,
  ): Effect.Effect<SnapshotAttributes[], snapshots.GetAllSnapshotsError, RuntimeContext>;
  /** Make a deactivated snapshot usable again and wait until it is active. */
  activate(
    idOrName: string,
  ): Effect.Effect<
    SnapshotAttributes,
    snapshots.GetSnapshotError | snapshots.ActivateSnapshotError | StateTimeout | StateFailed,
    RuntimeContext
  >;
  /** Deactivate a snapshot; sandboxes can't be created from it until it is activated. */
  deactivate(
    idOrName: string,
  ): Effect.Effect<void, snapshots.DeactivateSnapshotError, RuntimeContext>;
  /** A URL streaming the snapshot's build logs. */
  buildLogsUrl(
    idOrName: string,
  ): Effect.Effect<snapshots.Url, snapshots.GetSnapshotBuildLogsUrlError, RuntimeContext>;
  /** Delete a snapshot and wait until it is gone. Deleting a missing one succeeds. */
  delete(
    idOrName: string,
  ): Effect.Effect<
    void,
    snapshots.RemoveSnapshotError | snapshots.GetSnapshotError | StateTimeout,
    RuntimeContext
  >;
}

/**
 * Options for {@link CreateSnapshot}. Snapshots have only a name, no labels
 * or description, so a `prefix` is how you find the ones a binding
 * created: the binding refuses names that don't start with it.
 */
export interface CreateSnapshotOptions {
  /** Every name the binding creates must start with this. */
  readonly prefix?: string;
}

/**
 * Build Daytona snapshots at runtime: a warm base per repository, built
 * when it's first needed, that later sandboxes start from. To capture a
 * sandbox you already have, use `sandbox.createSandboxSnapshot` on its
 * handle.
 *
 * The host gets its own Daytona API key with `write:snapshots`,
 * `delete:snapshots` and, for `from` builds, `write:sandboxes` and
 * `delete:sandboxes`. Snapshots have only a name, so the `prefix` you give
 * is how you find the ones it created. They are not deleted when the stack
 * is destroyed: `list()` and delete the names with your prefix to clean
 * them up.
 *
 * ### A Warm Base per Repository
 * **Example:** Build it on first use, then start sandboxes from it
 * ```typescript
 * const images = yield* Daytona.CreateSnapshot({ prefix: "repo-" });
 * const name = `repo-${owner}-${repo}`;
 * const base =
 *   (yield* images.get(name)) ??
 *   (yield* images.create({
 *     name,
 *     from: "daytonaio/sandbox:0.4.3",
 *     run: [`git clone https://github.com/${owner}/${repo} /home/daytona/repo`, "cd /home/daytona/repo && npm ci"],
 *   }));
 * const sandbox = yield* sandboxes.create({ snapshot: base.name });
 * ```
 *
 * @binding
 * @product Snapshot
 */
export interface CreateSnapshot extends Binding.Service<
  CreateSnapshot,
  "Daytona.CreateSnapshot",
  (options?: CreateSnapshotOptions) => Effect.Effect<CreateSnapshotClient>
> {}

export const CreateSnapshot = Binding.Service<CreateSnapshot>("Daytona.CreateSnapshot");
