import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DictsOps } from "./CreateDictHttp.ts";
import type { ensureDict, lookupDict } from "./Dict.ts";
import type { DictAttributes } from "./Dict.ts";
import type { ReadWriteDictClient } from "./DictClient.ts";
import type { Environment } from "./Environment.ts";
import type { ErrorOf, OpError } from "./internal.ts";

/** A dict created or found at runtime: its attributes plus a read-write client. */
export interface DictHandle extends ReadWriteDictClient {
  readonly dictId: Effect.Effect<string>;
  readonly name: string;
  /** The attributes, to pass where a `Modal.Dict` is accepted (e.g. sandbox mounts). */
  readonly attributes: DictAttributes;
}

/** Get, create, list and delete dicts by name in one environment. */
export interface DictsClientOf<R> {
  /** The dict named `name`, created when missing (Modal's own get-or-create). */
  getOrCreate(name: string): Effect.Effect<DictHandle, ErrorOf<typeof ensureDict>, R>;
  /** The dict named `name`, or `undefined`. */
  get(name: string): Effect.Effect<DictHandle | undefined, ErrorOf<typeof lookupDict>, R>;
  /** Delete the dict named `name` (no-op when missing). */
  delete(
    name: string,
  ): Effect.Effect<
    void,
    | ErrorOf<typeof lookupDict>
    | Exclude<OpError<DictsOps, "delete">, { readonly _tag: "DictNotFound" }>,
    R
  >;
  /** Names of every dict in the environment. */
  list(): Effect.Effect<ReadonlyArray<string>, OpError<DictsOps, "list">, R>;
}

/** A DictsClient whose calls run inside a deployed runtime. */
export type DictsClient = DictsClientOf<RuntimeContext>;

/**
 * Create dicts by name at runtime: one per user, session or task.
 * Modal's native shape is get-or-create by name, so `getOrCreate` is
 * idempotent and safe to call on every request.
 *
 * Bind it to a `Modal.Environment` to keep these runtime objects in their
 * own namespace (or to nothing, for the workspace's default environment).
 * They aren't in Alchemy state: deleting the environment removes them.
 *
 * Objects created at run time are tagged with the stack, stage and binding
 * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) and are not deleted when
 * the stack is destroyed. A Modal dict has only a name, so the tags become
 * its name prefix, `Modal.runtimePrefix({ stack, stage, id })`: list them
 * with `modal dict list` and delete the ones whose name starts with it.
 *
 * ### One dict per user
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
 *     const dicts = yield* Modal.CreateDict(Agents);
 *     const sandboxes = yield* Modal.CreateSandbox(Coder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const user = request.headers["x-user"] ?? "anonymous";
 *         const state = yield* dicts.getOrCreate(`state-${user}`);
 *         yield* state.put("lastSeen", Date.now());
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(Modal.CreateDictHttp, Modal.CreateSandboxHttp))),
 * ) {}
 * ```
 *
 * @binding
 * @product Dict
 */
export interface CreateDict extends Binding.Service<
  CreateDict,
  "Modal.CreateDict",
  (environment?: Environment) => Effect.Effect<DictsClient>
> {}

export const CreateDict = Binding.Service<CreateDict>("Modal.CreateDict");
