import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
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

test.provider.skipIf(!hasGcpCreds)(
  "PauseJob, ResumeJob, and RunJob on a scheduler job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const job = yield* GCP.CloudScheduler.Job("Ping", {
            schedule: "0 0 1 1 *",
            timeZone: "UTC",
            httpTarget: {
              uri: "https://example.com/",
              httpMethod: "GET",
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* job.name;
              const pauseJob = yield* GCP.CloudScheduler.PauseJob(job);
              const resumeJob = yield* GCP.CloudScheduler.ResumeJob(job);
              const runJob = yield* GCP.CloudScheduler.RunJob(job);
              return Effect.fn(function* () {
                const paused = yield* pauseJob();
                const resumed = yield* resumeJob();
                const ran = yield* runJob();
                return { paused, resumed, ran };
              });
            }),
          );
          return { job, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.paused.state).toEqual("PAUSED");
      expect(out.probe.resumed.state).toEqual("ENABLED");
      expect(out.probe.ran.name).toEqual(out.job.name);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
