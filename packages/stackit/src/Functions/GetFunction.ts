import type * as functions from "@distilled.cloud/stackit/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Function } from "./Function.ts";

export interface GetFunctionRequest extends Omit<
  functions.GetFunctionRequest,
  "projectId" | "functionId"
> {}

/**
 * Runtime binding for STACKIT Functions' `getFunction`: read a function's state, URLs and current revision.
 *
 * Bind this operation to a {@link Function} in a Function/Worker init phase and
 * provide {@link GetFunctionHttp}. The function's project and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `functions.function.get`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every function in the project.
 *
 * ### Reading the Function
 * **Example:** Read the bound function from a Cloudflare Worker
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
 *     const getFunction = yield* Stackit.Functions.GetFunction(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getFunction();
 *         return yield* HttpServerResponse.json({ state: live.state, url: live.url });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Functions.GetFunctionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Functions
 */
export interface GetFunction extends Binding.Service<
  GetFunction,
  "Stackit.Functions.GetFunction",
  (
    fn: Function<any>,
  ) => Effect.Effect<
    (
      request?: GetFunctionRequest,
    ) => Effect.Effect<functions.Function, functions.GetFunctionError, RuntimeContext>
  >
> {}

export const GetFunction = Binding.Service<GetFunction>("Stackit.Functions.GetFunction");
