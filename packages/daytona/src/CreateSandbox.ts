import type * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StateFailed, StateTimeout } from "./internal/Wait.ts";
import type { VolumeMount } from "./MountVolume.ts";
import type { SandboxInfo } from "./Sandbox.ts";
import type { DaytonaSandbox } from "./SandboxClient.ts";
import type { Snapshot } from "./Snapshot.ts";

/**
 * `create` input: Daytona's own create request, with volumes as `mounts`.
 * `snapshot` defaults to the binding's base; labels are merged with the
 * binding's owner label.
 */
export type CreateSandboxInput = Omit<
  sandboxes.CreateSandboxRequest,
  "xDaytonaOrganizationID" | "volumes"
> & {
  /**
   * Volumes to mount: `MountVolume` references, or entries naming a
   * `CreateVolume` handle (`{ volume: home, path: "/home/daytona/work" }`).
   */
  readonly mounts?: ReadonlyArray<VolumeMount>;
};

/** `list` filters: Daytona's own, with `labels` as an object. */
export type ListSandboxesInput = Omit<
  sandboxes.ListSandboxesRequest,
  "xDaytonaOrganizationID" | "labels" | "cursor"
> & { labels?: Record<string, string> };

export interface CreateSandboxClient {
  /**
   * Create a sandbox and wait until it has started. Returns its handle.
   */
  create(
    input?: CreateSandboxInput,
  ): Effect.Effect<
    DaytonaSandbox,
    sandboxes.CreateSandboxError | sandboxes.GetSandboxError | StateTimeout | StateFailed,
    RuntimeContext
  >;
  /** The sandbox with this id or name, or `undefined`. */
  get(
    idOrName: string,
  ): Effect.Effect<DaytonaSandbox | undefined, sandboxes.GetSandboxError, RuntimeContext>;
  /** Sandboxes matching the filters (by default, the ones from the binding's base). */
  list(
    input?: ListSandboxesInput,
  ): Effect.Effect<SandboxInfo[], sandboxes.ListSandboxesError, RuntimeContext>;
  /** Delete a sandbox. Deleting a missing one succeeds. */
  delete(idOrName: string): Effect.Effect<void, sandboxes.DeleteSandboxError, RuntimeContext>;
}

/**
 * Create, find and delete Daytona sandboxes at runtime, from a Worker,
 * Lambda or any other host: a sandbox per request, per user or per task.
 * Pass a {@link Snapshot} to create every sandbox from it (a warm base),
 * or nothing to pick the snapshot per call.
 *
 * The host gets its own Daytona API key, with only `write:sandboxes` and
 * `delete:sandboxes`. Every sandbox it creates is labeled with the
 * stack, stage and host as Daytona labels (`alchemy.stack`,
 * `alchemy.stage`, `alchemy.id`; Daytona doesn't allow `::` in a label
 * key), on top of your own labels. They are not deleted when the stack is
 * destroyed: list them by those labels to clean them up, e.g.
 * `sandboxes.list({ labels: { "alchemy.id": "Api" } })`.
 * Each sandbox comes back as a {@link DaytonaSandbox} handle with the whole
 * toolbox: processes, files, git, LSP, previews, forks and snapshots.
 *
 * ### Sandbox per Request
 * **Example:** Run a command in a fresh sandbox and delete it
 * ```typescript
 * const sandboxes = yield* Daytona.CreateSandbox(Base);
 * return {
 *   fetch: Effect.gen(function* () {
 *     const sandbox = yield* Effect.acquireRelease(
 *       sandboxes.create({ autoDeleteInterval: 0 }),
 *       (s) => sandboxes.delete(s.sandboxId).pipe(Effect.ignore),
 *     );
 *     const ls = yield* sandbox.exec("ls -la");
 *     return yield* HttpServerResponse.json(ls);
 *   }),
 * };
 * ```
 *
 * ### Sandbox per User
 * **Example:** Find the user's sandbox by name, or create it
 * ```typescript
 * const sandbox =
 *   (yield* sandboxes.get(`dev-${user}`)) ??
 *   (yield* sandboxes.create({ name: `dev-${user}`, labels: { user } }));
 * yield* sandbox.startSandbox();
 * yield* sandbox.git.cloneRepository({ url: repoUrl, path: "/home/daytona/repo" });
 * ```
 *
 * @binding
 * @product Sandbox
 */
export interface CreateSandbox extends Binding.Service<
  CreateSandbox,
  "Daytona.CreateSandbox",
  (base?: Snapshot) => Effect.Effect<CreateSandboxClient>
> {}

export const CreateSandbox = Binding.Service<CreateSandbox>("Daytona.CreateSandbox");
