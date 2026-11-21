import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Scheduler from "@alchemy.run/aws/Scheduler";
import * as SQS from "@alchemy.run/aws/SQS";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "env-handler.ts");

// Minimal Lambda whose init binds CreateSchedule. The binding's deploy-time
// half resolves the AWS environment, which in a fresh run is the first
// resolution — it must not bind the deployer's config into this env (#1842).
export class SchedulerEnvFunction extends Lambda.Function<Lambda.Function>()(
  "SchedulerEnvFunction",
) {}

export default SchedulerEnvFunction.make(
  { main },
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("SchedulerEnvQueue");
    yield* Scheduler.CreateSchedule(queue);

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(Effect.provide(Scheduler.CreateScheduleHttp)),
);
