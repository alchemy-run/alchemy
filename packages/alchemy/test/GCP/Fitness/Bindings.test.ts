import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as fitness from "@distilled.cloud/gcp/fitness_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const probeAccess = () =>
  fitness.listUsersDataSources({ userId: "me" }).pipe(
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound", "Unauthorized"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetUsersDataSource round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound", "Unauthorized"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Fitness.UsersDataSource("Steps", {
            name: "Alchemy Binding Steps",
            type: "derived",
            dataType: {
              name: "com.google.step_count.delta",
              field: [{ name: "steps", format: "integer" }],
            },
            application: { name: "Alchemy", version: "1" },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* source.dataStreamId;
              const getSource = yield* GCP.Fitness.GetUsersDataSource(source);
              return Effect.fn(function* () {
                const metadata = yield* getSource({});
                return { metadata };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.metadata.dataStreamId?.length ?? 0).toBeGreaterThan(0);
      expect(out.metadata.name).toContain("[alchemy ");
      expect(out.metadata.type).toEqual("derived");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
