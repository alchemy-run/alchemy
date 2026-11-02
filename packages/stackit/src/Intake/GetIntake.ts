import type * as intake from "@distilled.cloud/stackit/intake";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Intake } from "./Intake.ts";

export interface GetIntakeRequest extends Omit<
  intake.GetIntakeRequest,
  "projectId" | "regionId" | "intakeId"
> {}

/**
 * Runtime binding for Intake `getIntake`: read an intake's state and
 * `undeliveredMessageCount`, the pipeline's health signal.
 *
 * Bind this operation to a {@link Intake} in a Function/Worker init phase and
 * provide {@link GetIntakeHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `intake.intake.get` on the project of the bound
 * resource, the narrowest scope STACKIT binds roles on, so it reaches that whole
 * project. The deployer needs `iam.role.add` on that scope to define the role. The
 * spec uses this one action for runners, intakes and users alike.
 *
 * ### Checking Health
 * **Example:** Report undelivered messages from a Cloudflare Worker
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
 *     const getIntake = yield* Stackit.Intake.GetIntake(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getIntake({});
 *         return yield* HttpServerResponse.json({ state: live.state, undelivered: live.undeliveredMessageCount });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.GetIntakeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Intake
 * @category Intake
 */
export interface GetIntake extends Binding.Service<
  GetIntake,
  "Stackit.Intake.GetIntake",
  (
    intake: Intake,
  ) => Effect.Effect<
    (
      request: GetIntakeRequest,
    ) => Effect.Effect<intake.IntakeResponse, intake.GetIntakeError, RuntimeContext>
  >
> {}

export const GetIntake = Binding.Service<GetIntake>("Stackit.Intake.GetIntake");
