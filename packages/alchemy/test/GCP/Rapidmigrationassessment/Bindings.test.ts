import { Action } from "@/Action";
import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
const DISABLED_MESSAGE = "Rapid Migration Assessment API has not been used";

test.provider.skipIf(!!process.env.FAST)(
  "PauseCollector, ResumeCollector, and RegisterCollector on a collector",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      const missingName = `${parent}/collectors/alchemy-missing-collector`;
      const serviceAccount = `alchemy-testing@${project}.iam.gserviceaccount.com`;
      yield* stack.destroy();

      const access = yield* rma
        .getProjectsLocationsCollectors({ name: missingName })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("ok" as const)),
          Effect.catchTag("Forbidden", (error) => Effect.succeed(error)),
        );
      if (access !== "ok") {
        expect(access._tag).toEqual("Forbidden");
        expect(access.message).toContain(DISABLED_MESSAGE);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const collector = yield* GCP.Rapidmigrationassessment.Collector(
            "BindOnPrem",
            {
              location: "us-central1",
              displayName: "bind collector",
              collectionDays: 7,
              expectedAssetCount: 1,
              serviceAccount,
              labels: { env: "bind" },
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* collector.name;
              const pause =
                yield* GCP.Rapidmigrationassessment.PauseCollector(collector);
              const resume =
                yield* GCP.Rapidmigrationassessment.ResumeCollector(collector);
              const register =
                yield* GCP.Rapidmigrationassessment.RegisterCollector(
                  collector,
                );
              return Effect.fn(function* () {
                const paused = yield* pause().pipe(
                  Effect.map((operation) => ({
                    _tag: "ok" as const,
                    name: operation.name,
                  })),
                  Effect.catchTag(["BadRequest", "Conflict"], (error) =>
                    Effect.succeed({
                      _tag: error._tag,
                      message: error.message,
                    }),
                  ),
                );
                const resumed = yield* resume().pipe(
                  Effect.map((operation) => ({
                    _tag: "ok" as const,
                    name: operation.name,
                  })),
                  Effect.catchTag(["BadRequest", "Conflict"], (error) =>
                    Effect.succeed({
                      _tag: error._tag,
                      message: error.message,
                    }),
                  ),
                );
                const registered = yield* register().pipe(
                  Effect.map((operation) => ({
                    _tag: "ok" as const,
                    name: operation.name,
                  })),
                  Effect.catchTag(["BadRequest", "Conflict"], (error) =>
                    Effect.succeed({
                      _tag: error._tag,
                      message: error.message,
                    }),
                  ),
                );
                return { paused, resumed, registered };
              });
            }),
          );
          return { collector, probe: yield* Probe({}) };
        }),
      );

      expect(out.collector.name).toContain("/collectors/");
      expect(["ok", "BadRequest", "Conflict"]).toContain(out.probe.paused._tag);
      expect(["ok", "BadRequest", "Conflict"]).toContain(
        out.probe.resumed._tag,
      );
      expect(["ok", "BadRequest", "Conflict"]).toContain(
        out.probe.registered._tag,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:rapidmigrationassessment", "live"],
    timeout: 120_000,
  },
);
