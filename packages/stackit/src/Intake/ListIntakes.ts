import type * as intake from "@distilled.cloud/stackit/intake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListIntakesRequest extends Omit<
  intake.ListIntakesRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for Intake `listIntakes`: list one page of the intakes in a
 * project and region. Pass `pageToken` from a response's `nextPageToken` to read the
 * next page.
 *
 * Bind this operation to any resource in that project and region (a {@link
 * BindingScope}) in a Function/Worker init phase and provide {@link
 * ListIntakesHttp}. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `intake.intake.list` on the project of the
 * bound resource, the narrowest scope STACKIT binds roles on, so it reaches that
 * whole project. The deployer needs `iam.role.add` on that scope to define the role.
 * The spec uses this one action for runners, intakes and users alike.
 *
 * ### Listing Intakes
 * **Example:** List intake names from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ingest = Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* Ingest;
 *     const listIntakes = yield* Stackit.Intake.ListIntakes(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { intakes } = yield* listIntakes({ pageSize: 50 });
 *         return yield* HttpServerResponse.json({ names: intakes.map((item) => item.displayName) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.ListIntakesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Intake
 * @category Intake
 */
export interface ListIntakes extends Binding.Service<
  ListIntakes,
  "Stackit.Intake.ListIntakes",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: ListIntakesRequest,
    ) => Effect.Effect<intake.ListIntakesResponse, intake.ListIntakesError, RuntimeContext>
  >
> {}

export const ListIntakes = Binding.Service<ListIntakes>("Stackit.Intake.ListIntakes");
