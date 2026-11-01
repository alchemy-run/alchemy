import type * as intake from "@distilled.cloud/stackit/intake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Intake } from "./Intake.ts";

export interface ListUsersRequest extends Omit<
  intake.ListIntakeUsersRequest,
  "projectId" | "regionId" | "intakeId"
> {}

/**
 * Runtime binding for Intake `listIntakeUsers`: list one page of the users of an
 * intake. Pass `pageToken` from a response's `nextPageToken` to read the next page.
 *
 * Bind this operation to a {@link Intake} in a Function/Worker init phase and
 * provide {@link ListUsersHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `intake.intake.list` on the project of the
 * bound resource, the narrowest scope STACKIT binds roles on, so it reaches that
 * whole project. The deployer needs `iam.role.add` on that scope to define the role.
 * The spec uses this one action for runners, intakes and users alike.
 *
 * ### Listing Users
 * **Example:** List an intake's users from a Cloudflare Worker
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
 * export const Events = Ingest.pipe(
 *   Effect.flatMap((runner) =>
 *     Stackit.Intake.Intake("Events", {
 *       runnerId: runner.runnerId,
 *       catalog: { uri: "https://iceberg.example.com/catalog", warehouse: "lake" },
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* Events;
 *     const listUsers = yield* Stackit.Intake.ListUsers(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { intakeUsers } = yield* listUsers({ pageSize: 50 });
 *         return yield* HttpServerResponse.json({ names: intakeUsers.map((user) => user.displayName) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.ListUsersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Intake
 * @category Intake
 */
export interface ListUsers extends Binding.Service<
  ListUsers,
  "Stackit.Intake.ListUsers",
  (
    intake: Intake,
  ) => Effect.Effect<
    (
      request: ListUsersRequest,
    ) => Effect.Effect<intake.ListIntakeUsersResponse, intake.ListIntakeUsersError, RuntimeContext>
  >
> {}

export const ListUsers = Binding.Service<ListUsers>("Stackit.Intake.ListUsers");
