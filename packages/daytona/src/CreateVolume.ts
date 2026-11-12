import type * as volumes from "@distilled.cloud/daytona/volumes";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { StateFailed, StateTimeout } from "./internal/Wait.ts";
import type { VolumeAttributes } from "./Volume.ts";

/** A name outside the binding's `prefix`. */
export class NameOutsidePrefix extends Data.TaggedError("Daytona.NameOutsidePrefix")<{
  readonly objectName: string;
  readonly prefix: string;
}> {
  override get message() {
    return `${this.objectName} must start with ${this.prefix}: the binding only manages names with that prefix`;
  }
}

export interface CreateVolumeClient {
  /**
   * The volume named `name`, created (and waited on until ready) if it
   * doesn't exist. Returns the same attributes as `Daytona.Volume`.
   */
  getOrCreate(input: {
    readonly name: string;
  }): Effect.Effect<
    VolumeAttributes,
    | volumes.CreateVolumeError
    | volumes.GetVolumeByNameError
    | volumes.GetVolumeError
    | StateTimeout
    | StateFailed
    | NameOutsidePrefix,
    RuntimeContext
  >;
  /** The volume with this name, or `undefined`. */
  get(
    name: string,
  ): Effect.Effect<VolumeAttributes | undefined, volumes.GetVolumeByNameError, RuntimeContext>;
  /** Every volume in the organization. */
  list(): Effect.Effect<VolumeAttributes[], volumes.ListVolumesError, RuntimeContext>;
  /**
   * Delete a volume. Returns once Daytona has accepted the delete; it
   * removes the volume in the background. Fails with `VolumeInUse` while a
   * sandbox mounts it: Daytona releases a volume about a minute after the
   * sandbox that wrote to it is deleted, so retry later. Deleting a missing
   * one succeeds.
   */
  delete(
    volumeId: string,
  ): Effect.Effect<
    void,
    volumes.DeleteVolumeError | volumes.GetVolumeError | StateTimeout,
    RuntimeContext
  >;
}

/**
 * Options for {@link CreateVolume}. Volumes have only a name, no labels or
 * description, so a `prefix` is how you find the ones a binding created:
 * the binding refuses names that don't start with it.
 */
export interface CreateVolumeOptions {
  /** Every name the binding creates or gets must start with this. */
  readonly prefix?: string;
}

/**
 * Create, find and delete Daytona volumes at runtime: a volume per user,
 * per project or per session, mounted into the sandboxes you create.
 *
 * The host gets its own Daytona API key with `read:volumes`,
 * `write:volumes` and `delete:volumes`. Volumes have only a name, so the
 * `prefix` you give is how you find the ones it created. They are not
 * deleted when the stack is destroyed: `list()` and delete the names with
 * your prefix to clean them up.
 *
 * ### Volume per User
 * **Example:** Mount the user's volume as their home directory
 * ```typescript
 * const volumes = yield* Daytona.CreateVolume({ prefix: "user-" });
 * const sandboxes = yield* Daytona.CreateSandbox(Base);
 * return {
 *   fetch: Effect.gen(function* () {
 *     const home = yield* volumes.getOrCreate({ name: `user-${user}` });
 *     const sandbox = yield* sandboxes.create({
 *       mounts: [{ volume: home, path: "/home/daytona/work" }],
 *     });
 *     const ls = yield* sandbox.exec("ls /home/daytona/work");
 *     return yield* HttpServerResponse.json(ls);
 *   }),
 * };
 * ```
 *
 * @binding
 * @product Volume
 */
export interface CreateVolume extends Binding.Service<
  CreateVolume,
  "Daytona.CreateVolume",
  (options?: CreateVolumeOptions) => Effect.Effect<CreateVolumeClient>
> {}

export const CreateVolume = Binding.Service<CreateVolume>("Daytona.CreateVolume");
