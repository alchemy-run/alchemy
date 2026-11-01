import type * as intake from "@distilled.cloud/stackit/intake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { User } from "./User.ts";

export interface GetUserRequest extends Omit<
  intake.GetIntakeUserRequest,
  "projectId" | "regionId" | "intakeId" | "intakeUserId"
> {}

/**
 * Runtime binding for Intake `getIntakeUser`: read a user's SASL name, state and
 * `clientConfig`. The password isn't in the answer: STACKIT can't return it.
 *
 * Bind this operation to a {@link User} in a Function/Worker init phase and provide
 * {@link GetUserHttp}. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `intake.intake.get` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches that whole
 * project. The deployer needs `iam.role.add` on that scope to define the role. The
 * spec uses this one action for runners, intakes and users alike.
 *
 * ### Reading the User
 * **Example:** Read the user from a Cloudflare Worker
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
 * export const Producer = Events.pipe(
 *   Effect.flatMap((events) =>
 *     Stackit.Intake.User("Producer", {
 *       intakeId: events.intakeId,
 *       password: "replace-with-a-secret-Pw1!",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* Producer;
 *     const getUser = yield* Stackit.Intake.GetUser(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getUser({});
 *         return yield* HttpServerResponse.json({ user: live.user, state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.GetUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Intake
 * @category Intake
 */
export interface GetUser extends Binding.Service<
  GetUser,
  "Stackit.Intake.GetUser",
  (
    user: User,
  ) => Effect.Effect<
    (
      request: GetUserRequest,
    ) => Effect.Effect<intake.IntakeUserResponse, intake.GetIntakeUserError, RuntimeContext>
  >
> {}

export const GetUser = Binding.Service<GetUser>("Stackit.Intake.GetUser");
