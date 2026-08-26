import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
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

const runLifecycle = hasGcpCreds && !process.env.FAST;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

test.provider.skipIf(!runLifecycle)(
  "GetOdbNetwork invokes the HTTP binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsOdbNetworks({
          parent: `projects/${project}/locations/${location}`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const network = yield* GCP.Oracledatabase.OdbNetwork("OracleNet", {
            location,
            network: "default",
            labels: { env: "test" },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* network.name;
              const getNetwork =
                yield* GCP.Oracledatabase.GetOdbNetwork(network);
              return Effect.fn(function* () {
                return yield* getNetwork();
              });
            }),
          );
          return { network, live: yield* Probe({}) };
        }),
      );

      expect(out.live.name).toEqual(out.network.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
