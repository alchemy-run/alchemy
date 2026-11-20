import * as Lambda from "@alchemy.run/aws/Lambda";
import * as SQS from "@alchemy.run/aws/SQS";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/**
 * A Function the test deploys to the real cloud, consuming a queue emulated
 * by `alchemy dev`: a deployed Function cannot receive the emulator's events.
 */
export class UnbridgedEventFunction extends Lambda.Function<UnbridgedEventFunction>()(
  "UnbridgedEventFunction",
) {}

export default UnbridgedEventFunction.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("UnbridgedQueue").pipe(Alchemy.remote(false));
    yield* SQS.consumeQueueMessages(queue, {}, () => Effect.void);
  }).pipe(Effect.provide(Lambda.QueueEventSource)),
);
