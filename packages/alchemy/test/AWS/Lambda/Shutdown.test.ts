import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ShutdownProbe from "./shutdown-probe.ts";

const { test } = Test.make({ providers: AWS.providers() });

const filterLogs = Effect.fn(function* (
  logGroupName: string,
  filterPattern: string,
) {
  const result = yield* logs
    .filterLogEvents({ logGroupName, filterPattern })
    .pipe(Effect.catch(() => Effect.succeed({ events: [] })));
  return (result.events ?? []).length > 0;
});

/**
 * The fast half of the Shutdown-phase contract: the generated entry
 * registers an internal extension with the Extensions API at cold start.
 * Registration is the documented precondition for Lambda's SIGTERM window —
 * without any registered extension the sandbox is killed with 0 ms and no
 * signal; with an internal extension the runtime gets SIGTERM + 500 ms.
 *
 * A successful invoke proves registration doesn't hang Init (a registered
 * extension must signal readiness via the parked `/event/next` long-poll —
 * getting that wrong wedges Init and every invoke 502s). Lambda logs the
 * registration as an `EXTENSION` platform line, which pins that the
 * registration was actually accepted.
 *
 * The slow half — Lambda delivering SIGTERM at idle spin-down and the
 * instance finalizers running — takes many idle minutes and is gated below.
 */
test.provider(
  "entry registers the graceful-shutdown internal extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ShutdownProbe;
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get(fn.functionUrl!).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      expect(res.status).toBe(200);
      expect(yield* res.text).toBe("ok");

      const logGroupName = `/aws/lambda/${fn.functionName}`;
      const registered = yield* filterLogs(
        logGroupName,
        '"alchemy-graceful-shutdown"',
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (found) => found,
          times: 20,
        }),
      );
      expect(registered).toBe(true);

      // Post-response window: the handler registers a 2 s request-scope
      // finalizer, but the extension holds the Invoke phase open after the
      // response is returned — so a warm request must come back well under
      // the finalizer's duration...
      const [elapsed, warm] = yield* client
        .get(fn.functionUrl!)
        .pipe(Effect.timed);
      expect(warm.status).toBe(200);
      expect(Duration.toMillis(elapsed)).toBeLessThan(2_000);

      // ...while the finalizer still runs and its marker reaches the logs.
      const requestFinalized = yield* filterLogs(
        logGroupName,
        '"ALCHEMY_REQUEST_FINALIZED"',
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (found) => found,
          times: 20,
        }),
      );
      expect(requestFinalized).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);

/**
 * The slow half: leave the sandbox idle until Lambda spins it down, then
 * assert the SIGTERM handler closed the instance scope and the init-level
 * finalizer's marker reached CloudWatch. Idle spin-down takes several
 * minutes and is not under our control, so this only runs when explicitly
 * requested:
 *
 *     AWS_LAMBDA_TEST_SHUTDOWN=1 bun vitest run test/AWS/Lambda/Shutdown.test.ts
 */
test.provider.skipIf(!process.env.AWS_LAMBDA_TEST_SHUTDOWN)(
  "instance-scope finalizers run at idle spin-down",
  (stack) =>
    Effect.gen(function* () {
      const fn = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ShutdownProbe;
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get(fn.functionUrl!).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      expect(res.status).toBe(200);

      // Do NOT invoke again — every invoke resets the idle clock. Poll the
      // log group until the shutdown marker lands. No stack.destroy: keep
      // the deployment so a re-run continues observing the same function.
      const logGroupName = `/aws/lambda/${fn.functionName}`;
      const finalized = yield* filterLogs(
        logGroupName,
        '"ALCHEMY_INSTANCE_FINALIZED"',
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("30 seconds"),
          until: (found) => found,
          times: 17,
        }),
      );
      expect(finalized).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 600_000 },
);
