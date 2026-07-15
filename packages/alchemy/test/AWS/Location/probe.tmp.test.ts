import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as location from "@distilled.cloud/aws/location";
import { describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

const log = (message: string) => Effect.sync(() => console.log(message));

// TEMPORARY diagnostic probe — deleted after use.
describe("Location probes", () => {
  test.provider(
    "probe batchEvaluateGeofences + getJob raw errors",
    (_stack) =>
      Effect.gen(function* () {
        // 1. evaluate against a temp collection
        yield* location
          .createGeofenceCollection({ CollectionName: "alchemy-probe-fences" })
          .pipe(Effect.catchTag("ConflictException", () => Effect.void));

        const evaluated = yield* Effect.result(
          location.batchEvaluateGeofences({
            CollectionName: "alchemy-probe-fences",
            DevicePositionUpdates: [
              {
                DeviceId: "probe-device",
                Position: [-122.3493, 47.6205],
                SampleTime: new Date(),
              },
            ],
          }),
        );
        yield* log(
          Result.isSuccess(evaluated)
            ? `EVALUATE OK: ${JSON.stringify(evaluated.success)}`
            : `EVALUATE FAIL tag=${evaluated.failure._tag} ${String(evaluated.failure)} ${JSON.stringify(evaluated.failure)}`,
        );

        yield* location
          .deleteGeofenceCollection({ CollectionName: "alchemy-probe-fences" })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

        // 2. getJob / cancelJob for a missing job
        const got = yield* Effect.result(
          location.getJob({ JobId: "00000000-0000-4000-8000-000000000000" }),
        );
        yield* log(
          Result.isSuccess(got)
            ? `GETJOB OK: ${JSON.stringify(got.success)}`
            : `GETJOB FAIL tag=${got.failure._tag} ${String(got.failure)} ${JSON.stringify(got.failure)}`,
        );

        const cancelled = yield* Effect.result(
          location.cancelJob({
            JobId: "00000000-0000-4000-8000-000000000000",
          }),
        );
        yield* log(
          Result.isSuccess(cancelled)
            ? `CANCELJOB OK: ${JSON.stringify(cancelled.success)}`
            : `CANCELJOB FAIL tag=${cancelled.failure._tag} ${String(cancelled.failure)} ${JSON.stringify(cancelled.failure)}`,
        );

        // Intentionally fail so the collected diagnostics surface in the
        // reporter output (passing-test stdout is swallowed).
        const summary = [
          Result.isSuccess(evaluated)
            ? `EVALUATE OK ${JSON.stringify(evaluated.success)}`
            : `EVALUATE ${evaluated.failure._tag} ${String(evaluated.failure)}`,
          Result.isSuccess(got)
            ? "GETJOB OK"
            : `GETJOB ${got.failure._tag} ${String(got.failure)} ${JSON.stringify(got.failure)}`,
          Result.isSuccess(cancelled)
            ? "CANCELJOB OK"
            : `CANCELJOB ${cancelled.failure._tag} ${String(cancelled.failure)} ${JSON.stringify(cancelled.failure)}`,
        ].join(" ||| ");
        return yield* Effect.die(new Error(`DIAG: ${summary}`));
      }),
    { timeout: 120_000 },
  );
});
