import type * as functions from "@distilled.cloud/stackit/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Function } from "./Function.ts";

export interface ListFunctionsRequest extends Omit<functions.ListFunctionsRequest, "projectId"> {}

/**
 * Runtime binding for STACKIT Functions' `listFunctions`: list every function in the same project as the bound one.
 *
 * Bind this operation to a {@link Function} in a Function/Worker init phase and
 * provide {@link ListFunctionsHttp}. The function's project is injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `functions.function.list`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every function in the project.
 *
 * ### Listing Functions
 * **Example:** List the sibling functions from a Cloudflare Worker
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
 *     const listFunctions = yield* Stackit.Functions.ListFunctions(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const listed = yield* listFunctions();
 *         return yield* HttpServerResponse.json({
 *           names: (listed.functions ?? []).map((fn) => fn.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Functions.ListFunctionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Functions
 */
export interface ListFunctions extends Binding.Service<
  ListFunctions,
  "Stackit.Functions.ListFunctions",
  (
    fn: Function<any>,
  ) => Effect.Effect<
    (
      request?: ListFunctionsRequest,
    ) => Effect.Effect<
      functions.ListFunctionsResponse,
      functions.ListFunctionsError,
      RuntimeContext
    >
  >
> {}

export const ListFunctions = Binding.Service<ListFunctions>("Stackit.Functions.ListFunctions");
