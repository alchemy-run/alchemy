import type * as intake from "@distilled.cloud/stackit/intake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { User } from "./User.ts";

export interface UpdateUserRequest extends Omit<
  intake.UpdateIntakeUserRequest,
  "projectId" | "regionId" | "intakeId" | "intakeUserId"
> {}

/**
 * Runtime binding for Intake `updateIntakeUser`: change a user from a running host,
 * typically to rotate its password. A host bound to this user keeps the deployed
 * password, and the stack keeps its own props, so rotating with a new prop and a
 * deploy is usually what you want.
 *
 * Bind this operation to a {@link User} in a Function/Worker init phase and provide
 * {@link UpdateUserHttp}. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `intake.intake.update` on the project of the
 * bound resource, the narrowest scope STACKIT binds roles on, so it reaches that
 * whole project. The deployer needs `iam.role.add` on that scope to define the role.
 * The spec uses this one action for runners, intakes and users alike.
 *
 * ### Updating the User
 * **Example:** Update a user from a Cloudflare Worker
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
 *     const updateUser = yield* Stackit.Intake.UpdateUser(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* updateUser({ description: "rotated" });
 *         return yield* HttpServerResponse.json({ state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.UpdateUserHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Intake
 * @category Intake
 */
export interface UpdateUser extends Binding.Service<
  UpdateUser,
  "Stackit.Intake.UpdateUser",
  (
    user: User,
  ) => Effect.Effect<
    (
      request: UpdateUserRequest,
    ) => Effect.Effect<intake.IntakeUserResponse, intake.UpdateIntakeUserError, RuntimeContext>
  >
> {}

export const UpdateUser = Binding.Service<UpdateUser>("Stackit.Intake.UpdateUser");
