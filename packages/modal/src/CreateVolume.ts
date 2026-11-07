import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VolumesOps } from "./CreateVolumeHttp.ts";
import type { Environment } from "./Environment.ts";
import type { ErrorOf, OpError } from "./internal.ts";
import type { ensureVolume, lookupVolume } from "./Volume.ts";
import type { VolumeAttributes } from "./Volume.ts";
import type { ReadWriteVolumeClient } from "./VolumeClient.ts";

/** A volume created or found at runtime: its attributes plus a read-write client. */
export interface VolumeHandle extends ReadWriteVolumeClient {
  readonly volumeId: Effect.Effect<string>;
  readonly name: string;
  /** The attributes, to pass where a `Modal.Volume` is accepted (e.g. sandbox mounts). */
  readonly attributes: VolumeAttributes;
}

/** Get, create, list and delete volumes by name in one environment. */
export interface VolumesClientOf<R> {
  /** The volume named `name`, created when missing (Modal's own get-or-create). */
  getOrCreate(name: string): Effect.Effect<VolumeHandle, ErrorOf<typeof ensureVolume>, R>;
  /** The volume named `name`, or `undefined`. */
  get(name: string): Effect.Effect<VolumeHandle | undefined, ErrorOf<typeof lookupVolume>, R>;
  /** Delete the volume named `name` (no-op when missing). */
  delete(
    name: string,
  ): Effect.Effect<
    void,
    | ErrorOf<typeof lookupVolume>
    | Exclude<OpError<VolumesOps, "delete">, { readonly _tag: "VolumeNotFound" }>,
    R
  >;
  /** Names of every volume in the environment. */
  list(): Effect.Effect<ReadonlyArray<string>, OpError<VolumesOps, "list">, R>;
}

/** A VolumesClient whose calls run inside a deployed runtime. */
export type VolumesClient = VolumesClientOf<RuntimeContext>;

/**
 * Create volumes by name at runtime: one per user, session or task.
 * Modal's native shape is get-or-create by name, so `getOrCreate` is
 * idempotent and safe to call on every request.
 *
 * Bind it to a `Modal.Environment` to keep these runtime objects in their
 * own namespace (or to nothing, for the workspace's default environment).
 * They aren't in Alchemy state: deleting the environment removes them.
 *
 * Objects created at run time are tagged with the stack, stage and binding
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) and are not deleted when
 * the stack is destroyed. A Modal volume has only a name, so the tags become
 * its name prefix, `Modal.runtimePrefix({ stack, stage, id })`: list them
 * with `modal volume list` and delete the ones whose name starts with it.
 *
 * ### One volume per user
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Agents, Coder } from "./Coder.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const volumes = yield* Modal.CreateVolume(Agents);
 *     const sandboxes = yield* Modal.CreateSandbox(Coder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const user = request.headers["x-user"] ?? "anonymous";
 *         const home = yield* volumes.getOrCreate(`user-${user}`);
 *         yield* home.writeFile("/notes.md", "hello");
 *         const sandbox = yield* sandboxes.create({ mounts: [{ volume: home, path: "/home/user" }] });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Modal.CreateVolumeHttp, Modal.CreateSandboxHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @product Volume
 */
export interface CreateVolume extends Binding.Service<
  CreateVolume,
  "Modal.CreateVolume",
  (environment?: Environment) => Effect.Effect<VolumesClient>
> {}

export const CreateVolume = Binding.Service<CreateVolume>("Modal.CreateVolume");
