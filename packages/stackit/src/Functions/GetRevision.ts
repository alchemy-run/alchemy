import type * as functions from "@distilled.cloud/stackit/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Function } from "./Function.ts";

export interface GetRevisionRequest extends Omit<
  functions.GetRevisionRequest,
  "projectId" | "functionId"
> {}

/**
 * Runtime binding for STACKIT Functions' `getRevision`: read one revision of a function: its state, image, limits and variables. A plain variable's value is part of the answer, so this role can read whatever a function keeps in its environment.
 *
 * Bind this operation to a {@link Function} in a Function/Worker init phase and
 * provide {@link GetRevisionHttp}. The function's project and id are injected into each request; pass the `revisionId`. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `functions.revision.get`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every revision of every function in the project.
 *
 * ### Reading a Revision
 * **Example:** Check how a rollout went from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Backend = Stackit.Functions.Function("Backend", {
 *   image: "ghcr.io/my-org/backend:v1.0.0",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const backend = yield* Backend;
 *     const getRevision = yield* Stackit.Functions.GetRevision(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const revision = yield* getRevision({ revisionId: "..." });
 *         return yield* HttpServerResponse.json({ state: revision.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Functions.GetRevisionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Functions
 */
export interface GetRevision extends Binding.Service<
  GetRevision,
  "Stackit.Functions.GetRevision",
  (
    fn: Function<any>,
  ) => Effect.Effect<
    (
      request: GetRevisionRequest,
    ) => Effect.Effect<functions.Revision, functions.GetRevisionError, RuntimeContext>
  >
> {}

export const GetRevision = Binding.Service<GetRevision>("Stackit.Functions.GetRevision");
