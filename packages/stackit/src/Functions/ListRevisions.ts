import type * as functions from "@distilled.cloud/stackit/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Function } from "./Function.ts";

export interface ListRevisionsRequest extends Omit<
  functions.ListRevisionsRequest,
  "projectId" | "functionId"
> {}

/**
 * Runtime binding for STACKIT Functions' `listRevisions`: list the revisions of a function.
 *
 * Bind this operation to a {@link Function} in a Function/Worker init phase and
 * provide {@link ListRevisionsHttp}. The function's project and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `functions.revision.list`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every revision of every function in the project.
 *
 * ### Listing Revisions
 * **Example:** List the bound function's revisions from a Cloudflare Worker
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
 *     const listRevisions = yield* Stackit.Functions.ListRevisions(backend);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const listed = yield* listRevisions();
 *         return yield* HttpServerResponse.json({
 *           versions: (listed.revisionList ?? []).map((revision) => revision.version),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Functions.ListRevisionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Functions
 */
export interface ListRevisions extends Binding.Service<
  ListRevisions,
  "Stackit.Functions.ListRevisions",
  (
    fn: Function<any>,
  ) => Effect.Effect<
    (
      request?: ListRevisionsRequest,
    ) => Effect.Effect<
      functions.ListRevisionsResponse,
      functions.ListRevisionsError,
      RuntimeContext
    >
  >
> {}

export const ListRevisions = Binding.Service<ListRevisions>("Stackit.Functions.ListRevisions");
