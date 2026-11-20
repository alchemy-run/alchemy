import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { E2BError } from "./SandboxClient.ts";
import type { ReadWriteVolumeClient } from "./VolumeFiles.ts";

/** A volume created or found at runtime, with its files. */
export interface VolumeHandle {
  /** E2B's volume id. */
  readonly volumeId: string;
  /** The volume's name. Mount it with `mounts: [{ volume, path }]`. */
  readonly name: string;
  /** The volume's files, readable and writable without a sandbox. */
  readonly files: ReadWriteVolumeClient;
}

/** E2B volumes by name: create, look up, list and delete them. */
export interface VolumesClient {
  /** Creates a volume. Fails with `Conflict` when the name is taken. */
  create(name: string): Effect.Effect<VolumeHandle, E2BError, RuntimeContext>;
  /** The volume with this name or id, or `undefined`. */
  get(nameOrId: string): Effect.Effect<VolumeHandle | undefined, E2BError, RuntimeContext>;
  /** The volume with this name, created if missing. Safe to race. */
  getOrCreate(name: string): Effect.Effect<VolumeHandle, E2BError, RuntimeContext>;
  /** Every volume in the team. */
  list(): Effect.Effect<
    ReadonlyArray<{ readonly volumeId: string; readonly name: string }>,
    E2BError,
    RuntimeContext
  >;
  /** Deletes a volume and its files. Deleting one that is gone succeeds. */
  delete(volumeId: string): Effect.Effect<void, E2BError, RuntimeContext>;
}

/**
 * Create and manage E2B volumes at runtime, by name: a home directory per
 * user, a workspace per session. Mount one into a sandbox by its `name`, and
 * read or write its files with `files` without a sandbox.
 *
 * E2B volumes carry no metadata, so the volumes a host creates at runtime
 * are not deleted when the host is destroyed. Delete them with `delete` when
 * their owner goes away.
 *
 * ### Per-user volumes
 * **Example:** A home volume per user, mounted into their sandbox
 * ```typescript
 * const volumes = yield* E2B.CreateVolume();
 * const sandboxes = yield* E2B.CreateSandbox(Agent);
 * // in fetch:
 * const home = yield* volumes.getOrCreate(`user-${user}`);
 * const sandbox = yield* sandboxes.create({
 *   mounts: [{ volume: home, path: "/home/user/work" }],
 * });
 * ```
 *
 * @binding
 * @product Volume
 */
export interface CreateVolume extends Binding.Service<
  CreateVolume,
  "E2B.CreateVolume",
  () => Effect.Effect<VolumesClient>
> {}

export const CreateVolume = Binding.Service<CreateVolume>("E2B.CreateVolume");
